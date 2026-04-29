#!/usr/bin/env bash
# ============================================================
# Hytale Panel — Host-Side Updater Job Runner
# ============================================================
# Invoked by systemd via hytale-panel-updater@<jobId>.service. Runs as root.
#
# Lifecycle:
#   $0 run     <jobId>   — execute the job described in spec.json
#
# Inputs (read from /opt/hytale-panel-data/update-jobs/<jobId>/spec.json):
#   {
#     "kind": "update" | "rollback",
#     "targetTag": "v1.2.0",            // update only
#     "downloadUrl": "https://...",     // update only — already validated server-side
#     "tarballType": "tar.gz" | "zip",  // update only
#     "expectedSha256": "..." | null,
#     "currentVersion": "1.1.0",
#     "auditUserId": "..."
#   }
#
# Outputs (in /opt/hytale-panel-data/update-jobs/<jobId>/):
#   spec.json        — input, written by helper
#   status.json      — atomic-written progress: step, totalSteps, status, error, ...
#   logs.txt         — append-only stdout/stderr (also captured via systemd unit)
#
# All validation that depends on user input lives in the helper handler;
# this script trusts that spec.json contents have already been allowlisted.
# Defense-in-depth: we still check the URL host and tag format before use.
# ============================================================

set -uo pipefail

# ─── Constants ────────────────────────────────────────────────
PANEL_DIR="/opt/hytale-panel"
PANEL_DATA_DIR="/opt/hytale-panel-data"
BACKUP_DIR_ROOT="/opt/hytale-panel-backups"
JOBS_DIR="${PANEL_DATA_DIR}/update-jobs"
STAGING_DIR="${PANEL_DATA_DIR}/update-staging"
LOCK_FILE="${JOBS_DIR}/.lock"

HELPER_DEPLOY_SCRIPT="${PANEL_DIR}/deploy/deploy-helper.sh"
HELPER_UNIT="/etc/systemd/system/hytale-helper.service"
HELPER_WRAPPER_DIR="/usr/local/lib/hytale-panel"
PANEL_ENV="${PANEL_DIR}/.env"
HELPER_ENV="${PANEL_DIR}/helper/.env"

# Defaults — can be overridden via /opt/hytale-panel/.env at job time.
PANEL_UPDATE_BACKUP_RETENTION="${PANEL_UPDATE_BACKUP_RETENTION:-5}"
PANEL_UPDATE_MAX_DOWNLOAD_MB="${PANEL_UPDATE_MAX_DOWNLOAD_MB:-300}"
PANEL_UPDATE_RUN_TESTS="${PANEL_UPDATE_RUN_TESTS:-false}"
GITHUB_UPDATE_TOKEN="${GITHUB_UPDATE_TOKEN:-}"
PANEL_UPDATE_REPO="${PANEL_UPDATE_REPO:-hicham-pkg/Hytale-Server-Management-Panel}"

UPDATE_STEPS=(
  "downloading"
  "validating"
  "preflight"
  "backup"
  "applying"
  "rebuilding"
  "deploying-helper"
  "verifying"
  "done"
)
ROLLBACK_STEPS=(
  "locating-backup"
  "restoring-files"
  "restoring-helper-unit"
  "rebuilding"
  "deploying-helper"
  "verifying"
  "done"
)

# ─── Globals (job-scoped) ─────────────────────────────────────
JOB_ID=""
JOB_DIR=""
SPEC_FILE=""
STATUS_FILE=""
LOG_FILE=""
JOB_KIND=""
TOTAL_STEPS=0

usage() {
  echo "usage: $0 run <jobId>" >&2
  exit 64
}

# ─── Logging / status helpers ─────────────────────────────────
log() {
  # Logs are also captured by the systemd unit (StandardOutput=append:logs.txt)
  # but we write directly so log() works even if invoked outside systemd.
  local ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '[%s] %s\n' "$ts" "$*" | tee -a "$LOG_FILE"
}

# Atomic write of status.json — never expose partially-written JSON to readers.
write_status() {
  local tmp="${STATUS_FILE}.tmp.$$"
  cat >"$tmp" <<EOF
$1
EOF
  mv "$tmp" "$STATUS_FILE"
}

step_status_json() {
  local step="$1" step_name="$2" status="$3" error="${4:-null}"
  local started_at ended_at
  started_at="$(jq -r '.startedAt // empty' "$STATUS_FILE" 2>/dev/null || true)"
  if [ -z "$started_at" ]; then
    started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  fi
  if [ "$status" = "success" ] || [ "$status" = "failed" ]; then
    ended_at="\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\""
  else
    ended_at="null"
  fi

  local err_field
  if [ "$error" = "null" ]; then
    err_field="null"
  else
    err_field="\"$(printf '%s' "$error" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\t/\\t/g; s/\r//g' | tr '\n' ' ')\""
  fi

  cat <<JSON
{
  "jobId": "$JOB_ID",
  "kind": "$JOB_KIND",
  "step": $step,
  "stepName": "$step_name",
  "totalSteps": $TOTAL_STEPS,
  "status": "$status",
  "startedAt": "$started_at",
  "endedAt": $ended_at,
  "error": $err_field
}
JSON
}

set_step() {
  local step="$1" step_name="$2"
  log "→ step $step/$TOTAL_STEPS: $step_name"
  write_status "$(step_status_json "$step" "$step_name" "running" "null")"
}

mark_failed() {
  local step="$1" step_name="$2" error="$3"
  log "✗ FAILED at step $step/$TOTAL_STEPS ($step_name): $error"
  write_status "$(step_status_json "$step" "$step_name" "failed" "$error")"
  release_lock
  exit 1
}

mark_success() {
  log "✓ done"
  write_status "$(step_status_json "$TOTAL_STEPS" "done" "success" "null")"
  release_lock
  exit 0
}

# ─── Lock handling ────────────────────────────────────────────
acquire_lock() {
  exec 9>"$LOCK_FILE"
  if ! flock -n 9; then
    mark_failed 0 "locked" "another update or rollback job already holds the lock"
  fi
  echo "$JOB_ID" >&9
}
release_lock() {
  # Closing fd 9 releases the flock; the file itself is left in place so the
  # next reader can see what job last held it.
  exec 9>&- 2>/dev/null || true
}

# ─── URL allowlist ────────────────────────────────────────────
# Tag-only by design — branch downloads (refs/heads/*) are explicitly
# rejected. The panel updater is a release-pinned flow, not git-pull.
# Mirror of isAllowedDownloadUrl() in packages/helper/src/handlers/panel-update.ts;
# both layers must agree.
validate_download_url() {
  local url="$1" repo="$2"
  case "$url" in
    https://api.github.com/repos/${repo}/tarball/*       ) return 0 ;;
    https://api.github.com/repos/${repo}/zipball/*       ) return 0 ;;
    https://api.github.com/repos/${repo}/releases/*       ) return 0 ;;
    https://github.com/${repo}/archive/refs/tags/*       ) return 0 ;;
    https://github.com/${repo}/releases/download/*       ) return 0 ;;
    https://codeload.github.com/${repo}/tar.gz/refs/tags/*) return 0 ;;
    https://codeload.github.com/${repo}/zip/refs/tags/*  ) return 0 ;;
    https://objects.githubusercontent.com/*              ) return 0 ;;
    *) return 1 ;;
  esac
}

# ─── Step implementations ─────────────────────────────────────

read_spec() {
  if [ ! -r "$SPEC_FILE" ]; then
    mark_failed 0 "missing-spec" "$SPEC_FILE not found or unreadable"
  fi
  JOB_KIND="$(jq -r '.kind' "$SPEC_FILE")"
  case "$JOB_KIND" in
    update)   TOTAL_STEPS=$((${#UPDATE_STEPS[@]} - 1)) ;;   # 8 working steps + done
    rollback) TOTAL_STEPS=$((${#ROLLBACK_STEPS[@]} - 1)) ;;
    *) mark_failed 0 "bad-kind" "unknown job kind: $JOB_KIND" ;;
  esac
}

# Source /opt/hytale-panel/.env for retention/limit/token at job time. We do
# this AFTER spec validation so a malformed spec can't influence the env.
load_panel_env() {
  if [ -r "$PANEL_ENV" ]; then
    # shellcheck disable=SC1090
    set -a; . "$PANEL_ENV"; set +a
  fi
}

# Step 1 — download
do_download() {
  set_step 1 "downloading"
  local url tarball_type repo
  url="$(jq -r '.downloadUrl' "$SPEC_FILE")"
  tarball_type="$(jq -r '.tarballType' "$SPEC_FILE")"
  repo="$PANEL_UPDATE_REPO"

  if ! validate_download_url "$url" "$repo"; then
    mark_failed 1 "downloading" "download URL not in allowlist for repo $repo"
  fi

  rm -rf "$STAGING_DIR"
  mkdir -p "$STAGING_DIR"
  local archive
  archive="${STAGING_DIR}/release.${tarball_type}"
  local max_bytes=$((PANEL_UPDATE_MAX_DOWNLOAD_MB * 1024 * 1024))

  local curl_args=(--silent --show-error --fail --location
    --max-time 300
    --max-filesize "$max_bytes"
    --user-agent hytale-panel-updater
    --output "$archive")
  if [ -n "$GITHUB_UPDATE_TOKEN" ]; then
    curl_args+=(--header "Authorization: Bearer ${GITHUB_UPDATE_TOKEN}")
  fi
  curl_args+=(--header "Accept: application/octet-stream")
  curl_args+=("$url")

  if ! curl "${curl_args[@]}" >>"$LOG_FILE" 2>&1; then
    mark_failed 1 "downloading" "curl failed (exit $?). See logs."
  fi

  local size
  size="$(stat -c '%s' "$archive" 2>/dev/null || echo 0)"
  if [ "$size" -le 0 ]; then
    mark_failed 1 "downloading" "downloaded archive is empty"
  fi
  log "downloaded $size bytes to $archive"
  echo "$archive" >"${JOB_DIR}/.archive-path"
}

# Step 2 — validate (sha + safe extract)
do_validate() {
  set_step 2 "validating"
  local archive expected_sha actual_sha tarball_type
  archive="$(cat "${JOB_DIR}/.archive-path")"
  tarball_type="$(jq -r '.tarballType' "$SPEC_FILE")"
  expected_sha="$(jq -r '.expectedSha256 // empty' "$SPEC_FILE")"
  actual_sha="$(sha256sum "$archive" | awk '{print $1}')"
  log "sha256 = $actual_sha"
  echo "$actual_sha" >"${JOB_DIR}/.sha256"

  if [ -n "$expected_sha" ] && [ "$expected_sha" != "$actual_sha" ]; then
    mark_failed 2 "validating" "sha256 mismatch: expected $expected_sha got $actual_sha"
  fi

  # ─── Pre-extraction entry validation ─────────────────────────────────
  # Before writing anything to disk, list every entry in the archive and
  # reject absolute paths, .. components, or non-regular/non-link types.
  # This is belt-and-suspenders alongside the post-extraction walk below:
  # we trust neither GNU tar's nor unzip's "safe by default" reputation.
  local entries
  if [ "$tarball_type" = "tar.gz" ]; then
    # `tar -tzvf` prints type-mode-owner-size-name; we need both name and type.
    entries="$(tar -tzvf "$archive" 2>/dev/null)" || \
      mark_failed 2 "validating" "could not list archive entries"
    while IFS= read -r line; do
      [ -z "$line" ] && continue
      local type_char name
      type_char="${line:0:1}"
      name="${line##* }"
      case "$type_char" in
        -|d|l) ;;
        *) mark_failed 2 "validating" "non-regular entry in archive (type=$type_char): $name" ;;
      esac
      case "$name" in
        /*) mark_failed 2 "validating" "absolute path in archive: $name" ;;
        *"/../"*|"../"*|*"/.."|"..") mark_failed 2 "validating" "traversal in archive: $name" ;;
      esac
    done <<< "$entries"
  else
    entries="$(unzip -Z1 "$archive" 2>/dev/null)" || \
      mark_failed 2 "validating" "could not list archive entries"
    while IFS= read -r name; do
      [ -z "$name" ] && continue
      case "$name" in
        /*) mark_failed 2 "validating" "absolute path in archive: $name" ;;
        *"/../"*|"../"*|*"/.."|"..") mark_failed 2 "validating" "traversal in archive: $name" ;;
      esac
    done <<< "$entries"
  fi

  # Extract into a clean subdir.
  local extract_dir="${STAGING_DIR}/extracted"
  rm -rf "$extract_dir"; mkdir -p "$extract_dir"

  case "$tarball_type" in
    tar.gz)
      # GNU tar refuses unsafe paths with these flags. --no-same-owner ensures
      # files land owned by root rather than whatever the upstream uid was.
      if ! tar --no-same-owner --no-same-permissions \
               --exclude='*/node_modules' --exclude='*/.git' \
               -xzf "$archive" -C "$extract_dir" >>"$LOG_FILE" 2>&1; then
        mark_failed 2 "validating" "tar extraction failed"
      fi
      ;;
    zip)
      if ! unzip -q -d "$extract_dir" "$archive" >>"$LOG_FILE" 2>&1; then
        mark_failed 2 "validating" "unzip failed"
      fi
      ;;
    *) mark_failed 2 "validating" "unknown tarball type: $tarball_type" ;;
  esac

  # ─── Post-extraction tree validation ─────────────────────────────────
  # Walk the extracted tree and reject:
  #   - symlinks whose target is absolute or contains ../
  #   - hardlinks (link count > 1) — would let the archive smuggle a file
  #     that, after rsync apply, ends up sharing storage with something
  #     unexpected
  #   - device / FIFO / socket files
  while IFS= read -r -d '' f; do
    if [ -L "$f" ]; then
      local target
      target="$(readlink "$f")"
      case "$target" in
        /*) mark_failed 2 "validating" "absolute symlink in archive: $f -> $target" ;;
        *"/../"*|"../"*|*"/.."|"..") mark_failed 2 "validating" "traversal symlink in archive: $f -> $target" ;;
      esac
    elif [ -f "$f" ]; then
      local nlink
      nlink="$(stat -c '%h' "$f" 2>/dev/null || echo 1)"
      if [ "$nlink" -gt 1 ]; then
        mark_failed 2 "validating" "hardlink in archive: $f (nlink=$nlink)"
      fi
    fi
    if [ -b "$f" ] || [ -c "$f" ] || [ -p "$f" ] || [ -S "$f" ]; then
      mark_failed 2 "validating" "non-regular file in archive: $f"
    fi
  done < <(find "$extract_dir" -mindepth 1 -print0)

  # Find the extracted source root — GitHub tarballs nest it one level deep.
  local roots
  roots=$(find "$extract_dir" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')
  if [ "$roots" != "1" ]; then
    mark_failed 2 "validating" "expected exactly one top-level directory in archive, got $roots"
  fi
  local src
  src="$(find "$extract_dir" -mindepth 1 -maxdepth 1 -type d | head -n1)"
  echo "$src" >"${JOB_DIR}/.src-path"

  # Required files — if any are missing the archive isn't a valid panel release.
  local required=(
    "package.json"
    "pnpm-lock.yaml"
    "pnpm-workspace.yaml"
    "docker-compose.yml"
    "packages"
    "deploy"
    "scripts"
    "systemd"
  )
  for r in "${required[@]}"; do
    if [ ! -e "${src}/${r}" ]; then
      mark_failed 2 "validating" "release archive missing required path: $r"
    fi
  done

  # Confirm tag matches what the helper said it was downloading.
  local target_tag pkg_version
  target_tag="$(jq -r '.targetTag' "$SPEC_FILE" | sed -E 's/^v//')"
  pkg_version="$(jq -r '.version // ""' "${src}/packages/api/package.json")"
  if [ -n "$pkg_version" ] && [ "$pkg_version" != "$target_tag" ]; then
    mark_failed 2 "validating" "release tag $target_tag does not match packages/api/package.json version $pkg_version"
  fi
}

# Step 3 — preflight
do_preflight() {
  set_step 3 "preflight"
  local src
  src="$(cat "${JOB_DIR}/.src-path")"

  # Bash syntax check on shipped scripts.
  for s in "${src}/install.sh" "${src}/deploy/deploy-helper.sh" "${src}/scripts/doctor.sh"; do
    if [ -f "$s" ]; then
      if ! bash -n "$s" >>"$LOG_FILE" 2>&1; then
        mark_failed 3 "preflight" "bash syntax check failed: $s"
      fi
    fi
  done

  # Compose config validation runs against the staged tree but doesn't apply.
  if ! ( cd "$src" && docker compose config >/dev/null 2>>"$LOG_FILE" ); then
    mark_failed 3 "preflight" "docker compose config invalid in staged source"
  fi

  # Optional: pnpm install + build inside staged copy. We do this before
  # touching the live install so a build failure aborts cleanly.
  if ! ( cd "$src" && pnpm install --frozen-lockfile >>"$LOG_FILE" 2>&1 ); then
    mark_failed 3 "preflight" "pnpm install --frozen-lockfile failed"
  fi
  if ! ( cd "$src" && pnpm run build >>"$LOG_FILE" 2>&1 ); then
    mark_failed 3 "preflight" "pnpm run build failed"
  fi

  if [ "$PANEL_UPDATE_RUN_TESTS" = "true" ]; then
    if ! ( cd "$src" && pnpm test >>"$LOG_FILE" 2>&1 ); then
      mark_failed 3 "preflight" "pnpm test failed"
    fi
  else
    log "skipping pnpm test (set PANEL_UPDATE_RUN_TESTS=true in .env to enable)"
  fi
}

# Step 4 — backup current install
do_backup() {
  set_step 4 "backup"
  local ts backup_dir
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  backup_dir="${BACKUP_DIR_ROOT}/${ts}"
  mkdir -p "$backup_dir"

  # rsync excludes match the apply-step exclusions plus build artifacts that
  # never need to be in a restore.
  rsync -a --delete \
    --exclude='node_modules' \
    --exclude='.next' \
    --exclude='dist' \
    --exclude='build' \
    --exclude='.git' \
    --exclude='run' \
    "${PANEL_DIR}/" "${backup_dir}/panel/" >>"$LOG_FILE" 2>&1 || \
    mark_failed 4 "backup" "rsync of $PANEL_DIR failed"

  # Helper systemd unit can be modified across releases — keep a copy.
  if [ -f "$HELPER_UNIT" ]; then
    cp -a "$HELPER_UNIT" "${backup_dir}/hytale-helper.service" || \
      mark_failed 4 "backup" "could not copy $HELPER_UNIT"
  fi

  # Metadata for rollback selection / dashboard display.
  local current_version
  current_version="$(jq -r '.currentVersion // "unknown"' "$SPEC_FILE")"
  cat >"${backup_dir}/metadata.json" <<JSON
{
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "fromVersion": "$current_version",
  "jobId": "$JOB_ID",
  "kind": "$JOB_KIND"
}
JSON
  echo "$backup_dir" >"${JOB_DIR}/.backup-path"
  log "backup at $backup_dir"

  # Apply retention only after the new backup is on disk. Never delete the
  # latest two — even if PANEL_UPDATE_BACKUP_RETENTION is set very small —
  # so a follow-up rollback always has something to fall back to.
  prune_backups
}

prune_backups() {
  local retention="$PANEL_UPDATE_BACKUP_RETENTION"
  if ! [[ "$retention" =~ ^[0-9]+$ ]] || [ "$retention" -lt 2 ]; then
    retention=2
  fi
  # Sorted newest first; keep the first $retention.
  local to_delete
  mapfile -t to_delete < <(find "$BACKUP_DIR_ROOT" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' \
    | sort -rn | awk '{print $2}' | tail -n +"$((retention + 1))")
  for d in "${to_delete[@]:-}"; do
    [ -n "$d" ] || continue
    log "pruning old backup $d"
    rm -rf "$d"
  done
}

# Step 5 — apply (rsync staged source into /opt/hytale-panel)
do_apply() {
  set_step 5 "applying"
  local src
  src="$(cat "${JOB_DIR}/.src-path")"

  # Apply with --delete so removed-upstream files actually disappear, but
  # exclude all runtime/state paths so rsync doesn't touch them.
  rsync -a --delete \
    --exclude='node_modules' \
    --exclude='.next' \
    --exclude='dist' \
    --exclude='build' \
    --exclude='.git' \
    --exclude='run' \
    --exclude='.env' \
    --exclude='helper/.env' \
    --exclude='.DS_Store' \
    --exclude='._*' \
    "${src}/" "${PANEL_DIR}/" >>"$LOG_FILE" 2>&1 || \
    mark_failed 5 "applying" "rsync into $PANEL_DIR failed"

  # Reapply the runtime exec bits the staging area might have flattened.
  chmod +x "${PANEL_DIR}/install.sh" "${PANEL_DIR}/deploy/deploy-helper.sh" \
           "${PANEL_DIR}/scripts/"*.sh \
           "${PANEL_DIR}/systemd/hytale-helper-journalctl" \
           "${PANEL_DIR}/systemd/hytale-panel-updater-trigger" 2>/dev/null || true
}

# Step 6 — rebuild containers
do_rebuild() {
  set_step 6 "rebuilding"
  if ! ( cd "$PANEL_DIR" && docker compose up -d --build --force-recreate api web >>"$LOG_FILE" 2>&1 ); then
    mark_failed 6 "rebuilding" "docker compose up failed"
  fi
}

# Step 7 — deploy helper
do_deploy_helper() {
  set_step 7 "deploying-helper"
  # deploy-helper.sh refreshes the helper bundle, the systemd unit, the
  # sudoers files, and restarts hytale-helper.service. After this point the
  # helper RPC briefly disappears — by design, the dashboard polls status
  # files via the API container's read-only bind mount.
  if ! bash "$HELPER_DEPLOY_SCRIPT" >>"$LOG_FILE" 2>&1; then
    mark_failed 7 "deploying-helper" "deploy-helper.sh failed"
  fi
}

# Step 8 — verify
do_verify() {
  set_step 8 "verifying"
  # Wait for API health for up to 60s.
  local api_port deadline
  api_port="$(grep -E '^API_HOST_PORT=' "$PANEL_ENV" 2>/dev/null | cut -d= -f2 | tr -d ' "')"
  api_port="${api_port:-4000}"
  deadline=$(( $(date +%s) + 60 ))
  until curl --silent --fail --max-time 5 "http://127.0.0.1:${api_port}/api/health" >/dev/null 2>>"$LOG_FILE"; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
      mark_failed 8 "verifying" "API health did not respond within 60s"
    fi
    sleep 2
  done

  # doctor.sh as the final integration check. Failure here marks the job
  # failed; the dashboard will show the rollback button.
  if ! bash "${PANEL_DIR}/scripts/doctor.sh" >>"$LOG_FILE" 2>&1; then
    mark_failed 8 "verifying" "doctor.sh reported issues; see logs"
  fi
}

# Rollback path (applies the most recent backup unless one is named in spec)
do_rollback() {
  set_step 1 "locating-backup"
  local backup
  backup="$(jq -r '.backupPath // empty' "$SPEC_FILE")"
  if [ -z "$backup" ]; then
    backup="$(find "$BACKUP_DIR_ROOT" -mindepth 1 -maxdepth 1 -type d \
      | sort -r | head -n1)"
  fi
  if [ -z "$backup" ] || [ ! -d "${backup}/panel" ]; then
    mark_failed 1 "locating-backup" "no valid backup found under $BACKUP_DIR_ROOT"
  fi
  log "rolling back from $backup"

  set_step 2 "restoring-files"
  rsync -a --delete \
    --exclude='.env' \
    --exclude='helper/.env' \
    "${backup}/panel/" "${PANEL_DIR}/" >>"$LOG_FILE" 2>&1 || \
    mark_failed 2 "restoring-files" "rsync from backup failed"

  set_step 3 "restoring-helper-unit"
  if [ -f "${backup}/hytale-helper.service" ]; then
    cp -a "${backup}/hytale-helper.service" "$HELPER_UNIT" || \
      mark_failed 3 "restoring-helper-unit" "could not restore helper unit"
    systemctl daemon-reload >>"$LOG_FILE" 2>&1 || true
  fi

  set_step 4 "rebuilding"
  if ! ( cd "$PANEL_DIR" && docker compose up -d --build --force-recreate api web >>"$LOG_FILE" 2>&1 ); then
    mark_failed 4 "rebuilding" "docker compose up failed during rollback"
  fi

  set_step 5 "deploying-helper"
  if ! bash "$HELPER_DEPLOY_SCRIPT" >>"$LOG_FILE" 2>&1; then
    mark_failed 5 "deploying-helper" "deploy-helper.sh failed during rollback"
  fi

  set_step 6 "verifying"
  if ! bash "${PANEL_DIR}/scripts/doctor.sh" >>"$LOG_FILE" 2>&1; then
    mark_failed 6 "verifying" "doctor.sh reported issues after rollback"
  fi
}

# ─── Main ─────────────────────────────────────────────────────
main() {
  [ "$#" -eq 2 ] || usage
  [ "$1" = "run" ] || usage

  JOB_ID="$2"
  JOB_DIR="${JOBS_DIR}/${JOB_ID}"
  SPEC_FILE="${JOB_DIR}/spec.json"
  STATUS_FILE="${JOB_DIR}/status.json"
  LOG_FILE="${JOB_DIR}/logs.txt"

  # UUID v4 sanity (helper already validated, defense-in-depth).
  if ! [[ "$JOB_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]]; then
    echo "invalid job id" >&2; exit 65
  fi

  mkdir -p "$JOBS_DIR"
  [ -d "$JOB_DIR" ] || { echo "job dir missing: $JOB_DIR" >&2; exit 66; }
  : >"$LOG_FILE" 2>/dev/null || true

  read_spec
  load_panel_env
  acquire_lock

  case "$JOB_KIND" in
    update)
      do_download
      do_validate
      do_preflight
      do_backup
      do_apply
      do_rebuild
      do_deploy_helper
      do_verify
      ;;
    rollback)
      do_rollback
      ;;
  esac

  mark_success
}

main "$@"
