#!/usr/bin/env bash
# ============================================================
# Hytale Server Update Job Runner
# ============================================================
# Detached host-side runner for Hytale built-in update commands.
# Invoked by hytale-server-updater@<jobId>.service via a validating
# root-owned trigger. The API never runs tmux/systemctl/sudo directly.
# ============================================================

set -uo pipefail

PANEL_DATA_DIR="/opt/hytale-panel-data"
JOBS_DIR="${HYTALE_UPDATE_JOB_DIR:-${PANEL_DATA_DIR}/hytale-update-jobs}"
LOCK_FILE="${JOBS_DIR}/.lock"
HELPER_ENV="/opt/hytale-panel/helper/.env"

HYTALE_ROOT="${HYTALE_ROOT:-/opt/hytale}"
HYTALE_SAVE_ROOT="${HYTALE_SAVE_ROOT:-${HYTALE_ROOT}/Server/universe}"
HYTALE_SERVICE_NAME="${HYTALE_SERVICE_NAME:-hytale-tmux.service}"
TMUX_SESSION="${TMUX_SESSION:-hytale}"
TMUX_SOCKET_PATH="${TMUX_SOCKET_PATH:-${HYTALE_ROOT}/run/hytale.tmux.sock}"
BACKUP_PATH="${BACKUP_PATH:-/opt/hytale-backups}"
MODS_PATH="${MODS_PATH:-${HYTALE_ROOT}/mods}"
DISABLED_MODS_PATH="${DISABLED_MODS_PATH:-${HYTALE_ROOT}/mods-disabled}"
MOD_BACKUP_PATH="${MOD_BACKUP_PATH:-${HYTALE_ROOT}/mod-backups}"
HYTALE_UPDATE_PLAYER_WARNING_SECONDS="${HYTALE_UPDATE_PLAYER_WARNING_SECONDS:-30}"
HYTALE_UPDATE_CHECK_TIMEOUT_SECONDS="${HYTALE_UPDATE_CHECK_TIMEOUT_SECONDS:-60}"
HYTALE_UPDATE_DOWNLOAD_TIMEOUT_SECONDS="${HYTALE_UPDATE_DOWNLOAD_TIMEOUT_SECONDS:-900}"
HYTALE_UPDATE_APPLY_TIMEOUT_SECONDS="${HYTALE_UPDATE_APPLY_TIMEOUT_SECONDS:-900}"

JOB_ID=""
JOB_DIR=""
SPEC_FILE=""
STATUS_FILE=""
LOG_FILE=""
ACTION=""
TOTAL_STEPS=0

UPDATE_ERROR_PATTERNS='error|failed|exception|unable|invalid|cancelled|canceled'

usage() {
  echo "usage: $0 run <jobId>" >&2
  exit 64
}

load_env() {
  if [ -r "$HELPER_ENV" ]; then
    # shellcheck disable=SC1090
    set -a; . "$HELPER_ENV"; set +a
  fi
  JOBS_DIR="${HYTALE_UPDATE_JOB_DIR:-${PANEL_DATA_DIR}/hytale-update-jobs}"
  LOCK_FILE="${JOBS_DIR}/.lock"
  HYTALE_ROOT="${HYTALE_ROOT:-/opt/hytale}"
  HYTALE_SAVE_ROOT="${HYTALE_SAVE_ROOT:-${HYTALE_ROOT}/Server/universe}"
  HYTALE_SERVICE_NAME="${HYTALE_SERVICE_NAME:-hytale-tmux.service}"
  TMUX_SESSION="${TMUX_SESSION:-hytale}"
  TMUX_SOCKET_PATH="${TMUX_SOCKET_PATH:-${HYTALE_ROOT}/run/hytale.tmux.sock}"
  BACKUP_PATH="${BACKUP_PATH:-/opt/hytale-backups}"
  MODS_PATH="${MODS_PATH:-${HYTALE_ROOT}/mods}"
  DISABLED_MODS_PATH="${DISABLED_MODS_PATH:-${HYTALE_ROOT}/mods-disabled}"
  MOD_BACKUP_PATH="${MOD_BACKUP_PATH:-${HYTALE_ROOT}/mod-backups}"
}

log() {
  local ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '[%s] %s\n' "$ts" "$*" | tee -a "$LOG_FILE"
}

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\t/\\t/g; s/\r//g' | tr '\n' ' '
}

write_status() {
  local update_status="$1" step="$2" step_name="$3" status="$4" error="${5:-}"
  local tmp="${STATUS_FILE}.tmp.$$"
  local started_at ended_at error_json
  started_at="$(jq -r '.startedAt // empty' "$STATUS_FILE" 2>/dev/null || true)"
  [ -n "$started_at" ] || started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if [ "$status" = "success" ] || [ "$status" = "failed" ]; then
    ended_at="\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\""
  else
    ended_at="null"
  fi
  if [ -n "$error" ]; then
    error_json="\"$(json_escape "$error")\""
  else
    error_json="null"
  fi
  cat >"$tmp" <<JSON
{
  "jobId": "$JOB_ID",
  "kind": "hytale-update",
  "action": "$ACTION",
  "step": $step,
  "stepName": "$step_name",
  "totalSteps": $TOTAL_STEPS,
  "status": "$status",
  "updateStatus": "$update_status",
  "startedAt": "$started_at",
  "endedAt": $ended_at,
  "error": $error_json
}
JSON
  mv "$tmp" "$STATUS_FILE"
}

set_step() {
  local step="$1" step_name="$2" update_status="$3"
  log "→ step $step/$TOTAL_STEPS: $step_name"
  write_status "$update_status" "$step" "$step_name" "running"
}

fail_job() {
  local step="$1" step_name="$2" update_status="$3" message="$4"
  log "✗ FAILED at step $step/$TOTAL_STEPS ($step_name): $message"
  write_status "$update_status" "$step" "$step_name" "failed" "$message"
  release_lock
  exit 1
}

succeed_job() {
  local update_status="$1" message="$2"
  log "✓ $message"
  write_status "$update_status" "$TOTAL_STEPS" "done" "success"
  release_lock
  exit 0
}

acquire_lock() {
  mkdir -p "$JOBS_DIR"
  exec 9>"$LOCK_FILE"
  if ! flock -n 9; then
    fail_job 0 "locked" "failed" "another Hytale update job already holds the lock"
  fi
  echo "$JOB_ID" >&9
}

release_lock() {
  exec 9>&- 2>/dev/null || true
}

safe_under_root() {
  local target="$1" root="$2" real_root real_target
  real_root="$(realpath -m "$root")" || return 1
  real_target="$(realpath -m "$target")" || return 1
  case "$real_target" in
    "$real_root"|"$real_root"/*) return 0 ;;
    *) return 1 ;;
  esac
}

preflight() {
  safe_under_root "$HYTALE_SAVE_ROOT" "$HYTALE_ROOT" || return 10
  [ -d "$HYTALE_ROOT" ] || { log "missing Hytale root"; return 1; }
  [ -d "${HYTALE_ROOT}/Server" ] || { log "missing ${HYTALE_ROOT}/Server"; return 1; }
  [ -d "$HYTALE_SAVE_ROOT" ] || { log "missing save root $HYTALE_SAVE_ROOT"; return 1; }
  [ -d "${HYTALE_SAVE_ROOT}/worlds" ] || { log "missing worlds directory ${HYTALE_SAVE_ROOT}/worlds"; return 1; }
  if [ -d "${HYTALE_SAVE_ROOT}/players" ]; then
    log "players directory found"
  else
    log "players directory not present; continuing"
  fi
  if [ -f "${HYTALE_ROOT}/Assets.zip" ]; then
    log "Assets.zip found"
  else
    log "Assets.zip not found; continuing because some layouts may not use it"
  fi
  /usr/bin/systemctl status --no-pager "$HYTALE_SERVICE_NAME" >/dev/null 2>>"$LOG_FILE" || return 2
  /usr/bin/tmux -S "$TMUX_SOCKET_PATH" has-session -t "$TMUX_SESSION" >/dev/null 2>>"$LOG_FILE" || return 3
  local pid
  pid="$(runtime_pid || true)"
  [ -n "$pid" ] || { log "managed Java runtime not detected"; return 4; }
  mkdir -p "$JOBS_DIR" "$BACKUP_PATH" "$MOD_BACKUP_PATH"
  if command -v df >/dev/null 2>&1; then
    df -Pk "$HYTALE_ROOT" "$BACKUP_PATH" >>"$LOG_FILE" 2>&1 || true
  fi
  return 0
}

runtime_pid() {
  local pane_pids processes
  pane_pids="$(/usr/bin/tmux -S "$TMUX_SOCKET_PATH" list-panes -t "$TMUX_SESSION" -F '#{pane_pid}' 2>/dev/null || true)"
  [ -n "$pane_pids" ] || return 1
  processes="$(/usr/bin/ps -eo pid=,ppid=,state=,comm=,args= 2>/dev/null || true)"
  [ -n "$processes" ] || return 1
  awk -v roots="$pane_pids" -v hroot="$HYTALE_ROOT" '
    BEGIN { split(roots, r, /[[:space:]]+/); for (i in r) if (r[i] != "") wanted[r[i]]=1; changed=1; }
    { pid=$1; ppid=$2; state=$3; comm=$4; args=""; for (i=5;i<=NF;i++) args=args " " $i; parent[pid]=ppid; line[pid]=$0; command[pid]=comm; cmdline[pid]=args; stateByPid[pid]=state; pids[pid]=1; }
    END {
      while (changed) { changed=0; for (pid in pids) if (!wanted[pid] && wanted[parent[pid]]) { wanted[pid]=1; changed=1; } }
      for (pid in wanted) {
        lc=tolower(command[pid] " " cmdline[pid]);
        if (stateByPid[pid] !~ /Z/ && lc ~ /java/ && lc ~ /-jar/ && (lc ~ /hytaleserver\.jar/ || lc ~ /server\.jar/ || index(lc, tolower(hroot)) > 0)) { print pid; exit 0; }
      }
      exit 1;
    }
  ' <<< "$processes"
}

send_console() {
  local command="$1"
  log "console ← $command"
  /usr/bin/tmux -S "$TMUX_SOCKET_PATH" send-keys -t "$TMUX_SESSION" "$command" Enter >>"$LOG_FILE" 2>&1
}

capture_console() {
  /usr/bin/tmux -S "$TMUX_SOCKET_PATH" capture-pane -t "$TMUX_SESSION" -p -S -240 2>/dev/null || true
}

wait_for_console_pattern() {
  local timeout="$1" success_regex="$2" failure_regex="${3:-$UPDATE_ERROR_PATTERNS}"
  local deadline output
  deadline=$(( $(date +%s) + timeout ))
  while [ "$(date +%s)" -le "$deadline" ]; do
    output="$(capture_console)"
    if grep -Eiq "$failure_regex" <<< "$output"; then
      log "recent console output indicated failure"
      printf '%s\n' "$output" | tail -n 40 >>"$LOG_FILE"
      return 2
    fi
    if grep -Eiq "$success_regex" <<< "$output"; then
      printf '%s\n' "$output" | tail -n 30 >>"$LOG_FILE"
      return 0
    fi
    sleep 2
  done
  printf '%s\n' "$(capture_console)" | tail -n 40 >>"$LOG_FILE"
  return 1
}

run_update_status() {
  send_console "/update status" || return 1
  sleep 2
  capture_console | tail -n 30 >>"$LOG_FILE"
}

run_patchline() {
  send_console "/update patchline" || return 1
  sleep 2
  capture_console | tail -n 20 >>"$LOG_FILE"
}

run_check() {
  send_console "/update check" || return 1
  if wait_for_console_pattern "$HYTALE_UPDATE_CHECK_TIMEOUT_SECONDS" 'up.to.date|latest|update available|new version|available version|no update' 'error|failed|exception|unable|invalid'; then
    local output
    output="$(capture_console)"
    if grep -Eiq 'update available|new version|available version' <<< "$output"; then
      return 10
    fi
    return 0
  fi
  return $?
}

run_download() {
  send_console "/update download" || return 1
  wait_for_console_pattern "$HYTALE_UPDATE_DOWNLOAD_TIMEOUT_SECONDS" 'download(ed| complete)|staged|ready to apply|apply --confirm' 'error|failed|exception|unable|invalid|cancelled|canceled'
}

snapshot_configs() {
  local target="$1"
  mkdir -p "${target}/config"
  for rel in whitelist.json bans.json permissions.json server.properties config.json; do
    if [ -f "${HYTALE_ROOT}/Server/${rel}" ]; then
      cp -a "${HYTALE_ROOT}/Server/${rel}" "${target}/config/${rel}"
    fi
  done
}

create_update_backup() {
  local ts backup_name backup_dir universe_archive mods_archive disabled_archive
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  backup_name="hytale-update-${ts}-${JOB_ID}"
  backup_dir="${BACKUP_PATH}/${backup_name}"
  safe_under_root "$backup_dir" "$BACKUP_PATH" || return 1
  mkdir -p "$backup_dir"
  universe_archive="${backup_dir}/universe.tar.gz"
  mods_archive="${backup_dir}/mods.tar.gz"
  disabled_archive="${backup_dir}/mods-disabled.tar.gz"
  tar -C "$(dirname "$HYTALE_SAVE_ROOT")" -czf "$universe_archive" "$(basename "$HYTALE_SAVE_ROOT")" >>"$LOG_FILE" 2>&1 || return 2
  if [ -d "$MODS_PATH" ]; then
    tar -C "$(dirname "$MODS_PATH")" -czf "$mods_archive" "$(basename "$MODS_PATH")" >>"$LOG_FILE" 2>&1 || return 3
  fi
  if [ -d "$DISABLED_MODS_PATH" ]; then
    tar -C "$(dirname "$DISABLED_MODS_PATH")" -czf "$disabled_archive" "$(basename "$DISABLED_MODS_PATH")" >>"$LOG_FILE" 2>&1 || return 4
  fi
  snapshot_configs "$backup_dir" || return 5
  cat >"${backup_dir}/metadata.json" <<JSON
{
  "jobId": "$JOB_ID",
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "reason": "hytale-update-pre-apply",
  "hytaleRoot": "$HYTALE_ROOT",
  "saveRoot": "$HYTALE_SAVE_ROOT"
}
JSON
  echo "$backup_dir" >"${JOB_DIR}/.backup-path"
  log "backup snapshot created at $backup_dir"
}

warn_players() {
  local delay="$HYTALE_UPDATE_PLAYER_WARNING_SECONDS"
  if [ "$delay" -gt 0 ]; then
    send_console "say Server update will apply in ${delay} seconds. Connected players may be disconnected." || true
    sleep "$delay"
  fi
}

wait_for_restart_after_apply() {
  local before_pid="$1" deadline pid
  deadline=$(( $(date +%s) + HYTALE_UPDATE_APPLY_TIMEOUT_SECONDS ))
  while [ "$(date +%s)" -le "$deadline" ]; do
    /usr/bin/systemctl status --no-pager "$HYTALE_SERVICE_NAME" >/dev/null 2>>"$LOG_FILE" || true
    if /usr/bin/tmux -S "$TMUX_SOCKET_PATH" has-session -t "$TMUX_SESSION" >/dev/null 2>&1; then
      pid="$(runtime_pid || true)"
      if [ -n "$pid" ] && [ "$pid" != "$before_pid" ]; then
        log "runtime restarted with pid=$pid"
        return 0
      fi
    fi
    sleep 3
  done
  return 1
}

run_cancel() {
  send_console "/update cancel" || return 1
  sleep 2
  capture_console | tail -n 30 >>"$LOG_FILE"
}

do_check() {
  TOTAL_STEPS=3
  set_step 1 "preflight" "checking"
  preflight || fail_job 1 "preflight" "failed" "Hytale update preflight failed; see logs"
  set_step 2 "patchline" "checking"
  run_patchline || fail_job 2 "patchline" "failed" "Could not query update patchline"
  set_step 3 "checking" "checking"
  run_check
  case "$?" in
    0) succeed_job "up_to_date" "Hytale update check completed; no update detected" ;;
    10) succeed_job "update_available" "Hytale update check completed; update appears available" ;;
    *) fail_job 3 "checking" "failed" "Hytale update check failed or timed out" ;;
  esac
}

do_download() {
  TOTAL_STEPS=3
  set_step 1 "preflight" "downloading"
  preflight || fail_job 1 "preflight" "failed" "Hytale update preflight failed; see logs"
  set_step 2 "checking" "checking"
  run_update_status || true
  set_step 3 "downloading" "downloading"
  run_download || fail_job 3 "downloading" "failed" "Hytale update download failed or timed out"
  succeed_job "staged" "Hytale update downloaded and appears staged"
}

do_apply() {
  TOTAL_STEPS=4
  set_step 1 "preflight" "applying"
  preflight || fail_job 1 "preflight" "failed" "Hytale update preflight failed; see logs"
  set_step 2 "backup" "applying"
  create_update_backup || fail_job 2 "backup" "failed" "Backup snapshot failed; apply was not started"
  set_step 3 "applying" "applying"
  warn_players
  local before_pid
  before_pid="$(runtime_pid || true)"
  send_console "/update apply --confirm" || fail_job 3 "applying" "failed" "Could not send apply command"
  set_step 4 "verifying" "applying"
  wait_for_restart_after_apply "$before_pid" || fail_job 4 "verifying" "failed" "Server did not return healthy after apply timeout. Use the pre-update backup for recovery."
  succeed_job "succeeded" "Hytale update apply completed and server returned online"
}

do_update_now() {
  TOTAL_STEPS=7
  set_step 1 "preflight" "checking"
  preflight || fail_job 1 "preflight" "failed" "Hytale update preflight failed; see logs"
  set_step 2 "status" "checking"
  run_update_status || true
  set_step 3 "checking" "checking"
  run_check
  local check_result=$?
  if [ "$check_result" = "0" ]; then
    succeed_job "up_to_date" "Hytale is already up to date"
  elif [ "$check_result" != "10" ]; then
    fail_job 3 "checking" "failed" "Hytale update check failed or timed out"
  fi
  set_step 4 "downloading" "downloading"
  run_download || fail_job 4 "downloading" "failed" "Hytale update download failed or timed out"
  set_step 5 "backup" "staged"
  create_update_backup || fail_job 5 "backup" "failed" "Backup snapshot failed; apply was not started"
  set_step 6 "applying" "applying"
  warn_players
  local before_pid
  before_pid="$(runtime_pid || true)"
  send_console "/update apply --confirm" || fail_job 6 "applying" "failed" "Could not send apply command"
  set_step 7 "verifying" "applying"
  wait_for_restart_after_apply "$before_pid" || fail_job 7 "verifying" "failed" "Server did not return healthy after apply timeout. Use the pre-update backup for recovery."
  succeed_job "succeeded" "Hytale update completed and server returned online"
}

do_cancel() {
  TOTAL_STEPS=2
  set_step 1 "preflight" "checking"
  preflight || fail_job 1 "preflight" "failed" "Hytale update preflight failed; see logs"
  set_step 2 "cancel" "unknown"
  run_cancel || fail_job 2 "cancel" "failed" "Could not send update cancel command"
  succeed_job "unknown" "Hytale update cancel command sent"
}

main() {
  [ "$#" -eq 2 ] || usage
  [ "$1" = "run" ] || usage
  JOB_ID="$2"
  if ! [[ "$JOB_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]]; then
    echo "invalid job id" >&2
    exit 65
  fi
  load_env
  JOB_DIR="${JOBS_DIR}/${JOB_ID}"
  SPEC_FILE="${JOB_DIR}/spec.json"
  STATUS_FILE="${JOB_DIR}/status.json"
  LOG_FILE="${JOB_DIR}/logs.txt"
  [ -d "$JOB_DIR" ] || { echo "job dir missing: $JOB_DIR" >&2; exit 66; }
  : >"$LOG_FILE" 2>/dev/null || true
  ACTION="$(jq -r '.action // empty' "$SPEC_FILE" 2>/dev/null || true)"
  case "$ACTION" in
    check|download|apply|update-now|cancel) ;;
    *) fail_job 0 "bad-action" "failed" "unknown Hytale update action" ;;
  esac
  acquire_lock
  log "starting Hytale update action: $ACTION"
  case "$ACTION" in
    check) do_check ;;
    download) do_download ;;
    apply) do_apply ;;
    update-now) do_update_now ;;
    cancel) do_cancel ;;
  esac
}

if [ "${HYTALE_SERVER_UPDATER_LIB_ONLY:-0}" != "1" ]; then
  main "$@"
fi
