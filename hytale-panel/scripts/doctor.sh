#!/bin/bash
# ============================================================
# Hytale Panel — Doctor
# ============================================================
# Diagnoses the panel stack end-to-end and (optionally) applies safe
# repairs. Grouped output: Services / Network / Helper↔API / Database /
# Config / Resources / Hytale World.
#
# Usage:
#   bash scripts/doctor.sh            # diagnose only
#   bash scripts/doctor.sh --fix      # diagnose + auto-fix safe issues
#   bash scripts/doctor.sh --repair   # alias for --fix (back-compat)
#   bash scripts/doctor.sh --verbose  # include fix hints for every failing check
# ============================================================

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ROOT_ENV_FILE="$ROOT_DIR/.env"
HELPER_ENV_FILE="/opt/hytale-panel/helper/.env"
HELPER_DEPLOY_DIR="/opt/hytale-panel/helper"
HELPER_RUNTIME_DIR="/opt/hytale-panel/run"
EXPECTED_HOST_HELPER_SOCKET_PATH="${HELPER_RUNTIME_DIR}/hytale-helper.sock"
LEGACY_HOST_HELPER_SOCKET_PATH="/run/hytale-helper/hytale-helper.sock"
API_HELPER_SOCKET_PATH="/run/hytale-helper/hytale-helper.sock"
HYTALE_TMP_DIR="/opt/hytale/tmp"
HELPER_OVERRIDE_DIR="/etc/systemd/system/hytale-helper.service.d"
HELPER_OVERRIDE_FILE="${HELPER_OVERRIDE_DIR}/override.conf"
CONTAINER_API="hytale-panel-api"
CONTAINER_WEB="hytale-panel-web"
CONTAINER_DB="hytale-panel-db"
MIN_SECRET_LENGTH=32
MIN_DISK_FREE_GB=2
MIN_MEMORY_FREE_MB=128
PANEL_SOCKET_GROUP="hytale-panel"

FIX=0
VERBOSE=0
for arg in "$@"; do
  case "$arg" in
    --fix|--repair) FIX=1 ;;
    --verbose|-v) VERBOSE=1 ;;
    -h|--help)
      echo "Usage: bash scripts/doctor.sh [--fix] [--verbose]"
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      echo "Usage: bash scripts/doctor.sh [--fix] [--verbose]" >&2
      exit 1
      ;;
  esac
done

# ─── Output helpers ────────────────────────────────────────
if [ -t 1 ]; then
  COLOR_GREEN=$'\033[0;32m'
  COLOR_RED=$'\033[0;31m'
  COLOR_YELLOW=$'\033[1;33m'
  COLOR_BLUE=$'\033[0;34m'
  COLOR_DIM=$'\033[2m'
  COLOR_RESET=$'\033[0m'
else
  COLOR_GREEN=''
  COLOR_RED=''
  COLOR_YELLOW=''
  COLOR_BLUE=''
  COLOR_DIM=''
  COLOR_RESET=''
fi

failures=0
warnings=0
checks=0
repairs=0
CURRENT_SECTION=""

section() {
  CURRENT_SECTION="$1"
  printf '\n%s%s%s\n' "$COLOR_BLUE" "$1" "$COLOR_RESET"
}

ok() {
  checks=$((checks + 1))
  printf '  %s✓%s %s\n' "$COLOR_GREEN" "$COLOR_RESET" "$1"
}

fail() {
  checks=$((checks + 1))
  failures=$((failures + 1))
  local hint="${2:-}"
  printf '  %s✗%s %s\n' "$COLOR_RED" "$COLOR_RESET" "$1"
  if [ -n "$hint" ] && { [ "$VERBOSE" -eq 1 ] || [ "$FIX" -eq 0 ]; }; then
    printf '    %sfix:%s %s\n' "$COLOR_DIM" "$COLOR_RESET" "$hint"
  fi
}

warn() {
  checks=$((checks + 1))
  warnings=$((warnings + 1))
  local hint="${2:-}"
  printf '  %s○%s %s\n' "$COLOR_YELLOW" "$COLOR_RESET" "$1"
  if [ -n "$hint" ] && [ "$VERBOSE" -eq 1 ]; then
    printf '    %shint:%s %s\n' "$COLOR_DIM" "$COLOR_RESET" "$hint"
  fi
}

info() { printf '  %si%s %s\n' "$COLOR_BLUE" "$COLOR_RESET" "$1"; }

# ─── env file helpers ──────────────────────────────────────
read_env_value() {
  local file="$1"
  local key="$2"
  local value

  if [ ! -r "$file" ]; then
    return 1
  fi

  value="$(grep -E "^${key}=" "$file" | tail -n 1 | cut -d= -f2-)"
  value="${value%$'\r'}"

  if [ "${value#\"}" != "$value" ] && [ "${value%\"}" != "$value" ]; then
    value="${value#\"}"
    value="${value%\"}"
  elif [ "${value#\'}" != "$value" ] && [ "${value%\'}" != "$value" ]; then
    value="${value#\'}"
    value="${value%\'}"
  fi

  if [ -n "$value" ]; then
    printf '%s' "$value"
    return 0
  fi
  return 1
}

read_env_value_privileged() {
  local file="$1"
  local key="$2"
  local value

  value="$(read_env_value "$file" "$key" 2>/dev/null || true)"
  if [ -n "$value" ]; then
    printf '%s' "$value"
    return 0
  fi

  if command -v sudo >/dev/null 2>&1 && sudo -n test -r "$file" 2>/dev/null; then
    value="$(sudo grep -E "^${key}=" "$file" 2>/dev/null | tail -n 1 | cut -d= -f2- || true)"
    value="${value%$'\r'}"
    value="${value#\"}"
    value="${value%\"}"
    if [ -n "$value" ]; then
      printf '%s' "$value"
      return 0
    fi
  fi
  return 1
}

resolve_config_value() {
  local key="$1"
  local default_value="$2"
  shift 2

  if [ -n "${!key:-}" ]; then
    printf '%s' "${!key}"
    return 0
  fi

  local file value
  for file in "$@"; do
    value="$(read_env_value "$file" "$key" || true)"
    if [ -n "$value" ]; then
      printf '%s' "$value"
      return 0
    fi
  done

  printf '%s' "$default_value"
}

TMUX_SOCKET_PATH="$(resolve_config_value TMUX_SOCKET_PATH /opt/hytale/run/hytale.tmux.sock "$HELPER_ENV_FILE" "$ROOT_ENV_FILE")"
TMUX_SESSION="$(resolve_config_value TMUX_SESSION hytale "$HELPER_ENV_FILE" "$ROOT_ENV_FILE")"
API_HOST_PORT="$(resolve_config_value API_HOST_PORT 4000 "$ROOT_ENV_FILE")"
WEB_HOST_PORT="$(resolve_config_value WEB_HOST_PORT 3000 "$ROOT_ENV_FILE")"
POSTGRES_HOST_PORT="$(resolve_config_value POSTGRES_HOST_PORT 5432 "$ROOT_ENV_FILE")"
HYTALE_ROOT="$(resolve_config_value HYTALE_ROOT /opt/hytale "$HELPER_ENV_FILE")"
WHITELIST_PATH="$(resolve_config_value WHITELIST_PATH "$HYTALE_ROOT/Server/whitelist.json" "$HELPER_ENV_FILE")"
BANS_PATH="$(resolve_config_value BANS_PATH "$HYTALE_ROOT/Server/bans.json" "$HELPER_ENV_FILE")"
WORLDS_PATH="$(resolve_config_value WORLDS_PATH "$HYTALE_ROOT/Server/worlds" "$HELPER_ENV_FILE")"
BACKUP_PATH="$(resolve_config_value BACKUP_PATH /opt/hytale-backups "$HELPER_ENV_FILE")"

# ─── State flags (used by perform_fixes) ───────────────────
HELPER_SERVICE_ACTIVE=0
HELPER_UNIT_CONFIG_OK=0
HELPER_ENV_SOCKET_OK=0
HELPER_OVERRIDE_CLEAN=0
HELPER_RUNTIME_DIRECT_EXEC_OK=0
LEGACY_SERVICE_RETIRED=0
HOST_HELPER_SOCKET_OK=0
LEGACY_HOST_HELPER_SOCKET_EXISTS=0
API_SEES_HELPER_SOCKET=0
API_HEALTH_OK=0
WEB_PROXY_OK=0
HMAC_ROUND_TRIP_OK=0
POSTGRES_CONTAINER_OK=0
API_CONTAINER_OK=0
WEB_CONTAINER_OK=0
MIGRATIONS_CURRENT=0
MIGRATIONS_PENDING_COUNT=0
ROOT_ENV_PERMS_OK=0
HELPER_ENV_PERMS_OK=0
HELPER_DEPLOY_PERMS_OK=0
HELPER_RUNTIME_PERMS_OK=0
HYTALE_TMP_READY=0
TMUX_SOCKET_EXISTS=0
TMUX_SESSION_EXISTS=0
JAVA_PROCESS_EXISTS=0
JAVA_PROCESS_SUMMARY=""
GAME_SERVICE_ACTIVE=0
GAME_SERVICE_FAILED=0

# ─── Command helpers ───────────────────────────────────────
docker_compose() {
  if docker info >/dev/null 2>&1; then
    docker compose "$@"
    return $?
  fi
  if command -v sudo >/dev/null 2>&1 && sudo -n docker info >/dev/null 2>&1; then
    sudo docker compose "$@"
    return $?
  fi
  return 1
}

docker_cmd() {
  if docker info >/dev/null 2>&1; then
    docker "$@"
    return $?
  fi
  if command -v sudo >/dev/null 2>&1 && sudo -n docker info >/dev/null 2>&1; then
    sudo docker "$@"
    return $?
  fi
  return 1
}

stat_mode() {
  local path="$1"
  stat -c '%a' "$path" 2>/dev/null || sudo -n stat -c '%a' "$path" 2>/dev/null || true
}

stat_owner() {
  local path="$1"
  stat -c '%U:%G' "$path" 2>/dev/null || sudo -n stat -c '%U:%G' "$path" 2>/dev/null || true
}

helper_unit_value() {
  systemctl show -p "$1" --value hytale-helper.service 2>/dev/null | tr -d '\r'
}

port_listen_address() {
  local port="$1"
  local addr
  if command -v ss >/dev/null 2>&1; then
    addr=$(ss -Htnl 2>/dev/null | awk -v p=":$port\$" '$4 ~ p { print $4; exit }')
  fi
  if [ -z "${addr:-}" ] && command -v netstat >/dev/null 2>&1; then
    addr=$(netstat -tnl 2>/dev/null | awk -v p=":$port\$" '/^tcp/ && $4 ~ p { print $4; exit }')
  fi
  printf '%s' "${addr:-}"
}

port_is_loopback() {
  local port="$1"
  local addr
  addr="$(port_listen_address "$port")"
  [ -z "$addr" ] && return 2
  case "$addr" in
    127.0.0.1:"$port"|"[::1]:$port") return 0 ;;
    *) return 1 ;;
  esac
}

# ─── Hytale tmux/Java detection (preserved from prior doctor) ──
is_hytale_java_process() {
  local state="$1" comm="$2" args="$3"
  local state_upper comm_lower
  state_upper="$(printf '%s' "$state" | tr '[:lower:]' '[:upper:]')"
  printf '%s' "$state_upper" | grep -q 'Z' && return 1
  comm_lower="$(printf '%s' "$comm" | tr '[:upper:]' '[:lower:]')"
  case "$comm_lower" in java*) ;; *) return 1 ;; esac
  printf '%s\n' "$args" | grep -Eq '(^|[[:space:]])-jar([[:space:]]|$)' || return 1
  printf '%s\n' "$args" | grep -Eiq '(HytaleServer\.jar|server\.jar)' || return 1
  return 0
}

find_any_hytale_java() {
  local line pid state comm args
  while IFS= read -r line; do
    read -r pid state comm args <<< "$line"
    if is_hytale_java_process "$state" "$comm" "$args"; then
      printf '%s %s %s\n' "$pid" "$comm" "$args"
      return 0
    fi
  done < <(ps -eo pid=,state=,comm=,args= 2>/dev/null || true)
  return 0
}

tmux_session_exists() {
  sudo -n -u hytale tmux -S "$TMUX_SOCKET_PATH" has-session -t "$TMUX_SESSION" >/dev/null 2>&1
}

collect_descendant_pids() {
  local queue=("$@") seen=" " collected="" current child
  while [ "${#queue[@]}" -gt 0 ]; do
    current="${queue[0]}"; queue=("${queue[@]:1}")
    current="$(printf '%s' "$current" | tr -d '[:space:]')"
    [ -n "$current" ] || continue
    case " $seen " in *" $current "*) continue ;; esac
    seen="${seen}${current} "; collected="${collected}${current} "
    while IFS= read -r child; do
      child="$(printf '%s' "$child" | tr -d '[:space:]')"
      [ -n "$child" ] || continue
      case " $seen " in *" $child "*) ;; *) queue+=("$child") ;; esac
    done < <(ps -o pid= --ppid "$current" 2>/dev/null || true)
  done
  printf '%s' "$collected"
}

find_hytale_java_from_pid_list() {
  local pid_list="$1" line pid state comm args
  while IFS= read -r line; do
    read -r pid state comm args <<< "$line"
    case " $pid_list " in *" $pid "*) ;; *) continue ;; esac
    if is_hytale_java_process "$state" "$comm" "$args"; then
      printf '%s %s %s\n' "$pid" "$comm" "$args"
      return 0
    fi
  done < <(ps -eo pid=,state=,comm=,args= 2>/dev/null || true)
  return 0
}

find_hytale_java() {
  if ! tmux_session_exists; then
    find_any_hytale_java
    return 0
  fi
  local pane_pids
  pane_pids="$(sudo -n -u hytale tmux -S "$TMUX_SOCKET_PATH" list-panes -t "$TMUX_SESSION" -F '#{pane_pid}' 2>/dev/null | tr '\n' ' ')"
  if [ -z "${pane_pids// }" ]; then
    return 0
  fi
  local descendant_pids descendant_match
  descendant_pids="$(collect_descendant_pids $pane_pids)"
  descendant_match="$(find_hytale_java_from_pid_list "$descendant_pids")"
  if [ -n "$descendant_match" ]; then
    printf '%s\n' "$descendant_match"
    return 0
  fi
  find_any_hytale_java
}

# ─── HMAC round-trip ───────────────────────────────────────
compute_hmac_hex() {
  local secret="$1" payload="$2"
  printf '%s' "$payload" | openssl dgst -sha256 -mac HMAC -macopt "key:${secret}" -hex 2>/dev/null | awk '{print $NF}'
}

hmac_round_trip() {
  local socket="$EXPECTED_HOST_HELPER_SOCKET_PATH"
  [ -S "$socket" ] || return 2

  local secret
  secret="$(read_env_value_privileged "$HELPER_ENV_FILE" HELPER_HMAC_SECRET)"
  if [ -z "$secret" ]; then
    secret="$(read_env_value "$ROOT_ENV_FILE" HELPER_HMAC_SECRET 2>/dev/null || true)"
  fi
  [ -z "$secret" ] && return 3

  if ! command -v curl >/dev/null 2>&1 || ! command -v openssl >/dev/null 2>&1; then
    return 4
  fi

  local ts nonce payload sig body response
  ts=$(date +%s)
  nonce=$(openssl rand -hex 16)
  payload="${ts}:${nonce}:helper.ping:{}"
  sig=$(compute_hmac_hex "$secret" "$payload")
  [ -z "$sig" ] && return 5

  body=$(printf '{"operation":"helper.ping","params":{},"timestamp":%s,"nonce":"%s","signature":"%s"}' "$ts" "$nonce" "$sig")

  local curl_out
  if curl_out=$(curl -fsS --unix-socket "$socket" -H 'Content-Type: application/json' -d "$body" --max-time 5 http://localhost/rpc 2>/dev/null); then
    if printf '%s' "$curl_out" | grep -q '"pong":true' && printf '%s' "$curl_out" | grep -q '"success":true'; then
      return 0
    fi
    return 1
  fi

  if command -v sudo >/dev/null 2>&1; then
    if curl_out=$(sudo -n curl -fsS --unix-socket "$socket" -H 'Content-Type: application/json' -d "$body" --max-time 5 http://localhost/rpc 2>/dev/null); then
      if printf '%s' "$curl_out" | grep -q '"pong":true' && printf '%s' "$curl_out" | grep -q '"success":true'; then
        return 0
      fi
    fi
  fi
  return 1
}

# ─── Check groups ──────────────────────────────────────────
check_services() {
  section "SERVICES"

  if systemctl is-active --quiet hytale-helper.service; then
    HELPER_SERVICE_ACTIVE=1
    ok "hytale-helper.service active"
  else
    fail "hytale-helper.service not active" "sudo systemctl restart hytale-helper.service"
  fi

  local u g sg np
  u="$(helper_unit_value User)"
  g="$(helper_unit_value Group)"
  sg="$(helper_unit_value SupplementaryGroups)"
  np="$(helper_unit_value NoNewPrivileges | tr '[:upper:]' '[:lower:]')"
  if [ "$u" = "root" ] && [ "$g" = "hytale-panel" ] && printf '%s' "$sg" | grep -qw hytale && [ "$np" = "no" ]; then
    HELPER_UNIT_CONFIG_OK=1
    ok "Helper unit matches shipped model (root / hytale-panel / supp=hytale / NoNewPrivileges=false)"
  else
    fail "Helper unit drift: user=$u group=$g supp=$sg NNP=$np" "sudo cp systemd/hytale-helper.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl restart hytale-helper.service"
  fi

  if [ -f "$HELPER_OVERRIDE_FILE" ]; then
    fail "Stale helper override.conf at $HELPER_OVERRIDE_FILE" "sudo rm -f $HELPER_OVERRIDE_FILE && sudo systemctl daemon-reload"
  else
    HELPER_OVERRIDE_CLEAN=1
    ok "No stale helper override.conf"
  fi

  if [ -d "$HELPER_DEPLOY_DIR/dist" ] && find "$HELPER_DEPLOY_DIR/dist" -name '*.js' -exec grep -q '/usr/bin/sudo' {} + >/dev/null 2>&1; then
    fail "Installed helper runtime still uses legacy sudo execution" "sudo bash deploy/deploy-helper.sh"
  else
    HELPER_RUNTIME_DIRECT_EXEC_OK=1
    ok "Helper runtime uses direct host execution (no legacy sudo)"
  fi

  if systemctl list-unit-files hytale.service >/dev/null 2>&1; then
    if systemctl is-enabled --quiet hytale.service 2>/dev/null || systemctl is-active --quiet hytale.service 2>/dev/null; then
      fail "Legacy hytale.service still enabled or active" "sudo systemctl disable --now hytale.service"
    else
      LEGACY_SERVICE_RETIRED=1
      ok "Legacy hytale.service retired"
    fi
  else
    LEGACY_SERVICE_RETIRED=1
    ok "Legacy hytale.service not present"
  fi

  if systemctl is-active --quiet hytale-tmux.service; then
    GAME_SERVICE_ACTIVE=1
    ok "hytale-tmux.service active"
  else
    warn "hytale-tmux.service not active" "normal if the game server is intentionally stopped; otherwise: sudo systemctl restart hytale-tmux.service"
  fi

  if systemctl is-failed --quiet hytale-tmux.service; then
    GAME_SERVICE_FAILED=1
    fail "hytale-tmux.service is in failed state" "journalctl -u hytale-tmux.service --no-pager -n 50; sudo systemctl reset-failed hytale-tmux.service"
  fi

  if command -v docker >/dev/null 2>&1; then
    if docker_cmd info >/dev/null 2>&1; then
      ok "Docker daemon accessible"
    else
      fail "Docker daemon not accessible" "sudo systemctl start docker, or add your user to the docker group"
      return
    fi

    local state health
    state="$(docker_cmd inspect -f '{{.State.Status}}' "$CONTAINER_DB" 2>/dev/null || echo missing)"
    health="$(docker_cmd inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$CONTAINER_DB" 2>/dev/null || echo '')"
    if [ "$state" = "running" ]; then
      POSTGRES_CONTAINER_OK=1
      if [ -n "$health" ] && [ "$health" != "healthy" ]; then
        warn "postgres container running but health=$health" "docker compose logs postgres"
      else
        ok "postgres container running${health:+ (health=$health)}"
      fi
    else
      fail "postgres container not running (state=$state)" "docker compose up -d postgres"
    fi

    state="$(docker_cmd inspect -f '{{.State.Status}}' "$CONTAINER_API" 2>/dev/null || echo missing)"
    if [ "$state" = "running" ]; then
      API_CONTAINER_OK=1
      ok "api container running"
    else
      fail "api container not running (state=$state)" "docker compose up -d api"
    fi

    state="$(docker_cmd inspect -f '{{.State.Status}}' "$CONTAINER_WEB" 2>/dev/null || echo missing)"
    if [ "$state" = "running" ]; then
      WEB_CONTAINER_OK=1
      ok "web container running"
    else
      fail "web container not running (state=$state)" "docker compose up -d web"
    fi
  else
    warn "docker not installed; skipping container state checks" "install docker via install.sh or bash scripts/doctor.sh --fix won't help — needs a fresh install"
  fi
}

check_network() {
  section "NETWORK"

  if port_is_loopback "$API_HOST_PORT"; then
    ok "API listening on 127.0.0.1:${API_HOST_PORT} (not 0.0.0.0)"
  else
    local addr rc=$?
    addr="$(port_listen_address "$API_HOST_PORT")"
    if [ "$rc" -eq 2 ] || [ -z "$addr" ]; then
      fail "Nothing listening on port ${API_HOST_PORT}" "docker compose up -d api"
    else
      fail "API bound on $addr — should be 127.0.0.1:${API_HOST_PORT}" "check docker-compose.yml 'ports:' uses 127.0.0.1:\${API_HOST_PORT}"
    fi
  fi

  if port_is_loopback "$WEB_HOST_PORT"; then
    ok "Web listening on 127.0.0.1:${WEB_HOST_PORT} (not 0.0.0.0)"
  else
    local addr rc=$?
    addr="$(port_listen_address "$WEB_HOST_PORT")"
    if [ "$rc" -eq 2 ] || [ -z "$addr" ]; then
      fail "Nothing listening on port ${WEB_HOST_PORT}" "docker compose up -d web"
    else
      fail "Web bound on $addr — should be 127.0.0.1:${WEB_HOST_PORT}" "check docker-compose.yml 'ports:' uses 127.0.0.1:\${WEB_HOST_PORT}"
    fi
  fi

  if port_is_loopback "$POSTGRES_HOST_PORT"; then
    ok "Postgres listening on 127.0.0.1:${POSTGRES_HOST_PORT} (not 0.0.0.0)"
  else
    local addr rc=$?
    addr="$(port_listen_address "$POSTGRES_HOST_PORT")"
    if [ "$rc" -eq 2 ] || [ -z "$addr" ]; then
      warn "Nothing listening on port ${POSTGRES_HOST_PORT}" "postgres host exposure is optional"
    else
      fail "Postgres bound on $addr — should be 127.0.0.1:${POSTGRES_HOST_PORT}" "check docker-compose.yml 'ports:' uses 127.0.0.1:\${POSTGRES_HOST_PORT}"
    fi
  fi

  if curl -fsS --max-time 5 "http://127.0.0.1:${API_HOST_PORT}/api/health" >/dev/null 2>&1; then
    API_HEALTH_OK=1
    ok "/api/health responds directly on :${API_HOST_PORT}"
  else
    fail "/api/health not responding on 127.0.0.1:${API_HOST_PORT}" "docker compose logs --tail=50 api"
  fi

  if curl -fsS --max-time 5 "http://127.0.0.1:${WEB_HOST_PORT}/api/health" >/dev/null 2>&1; then
    WEB_PROXY_OK=1
    ok "/api/health reaches web proxy on :${WEB_HOST_PORT}"
  else
    fail "/api/health not reachable via web on 127.0.0.1:${WEB_HOST_PORT}" "docker compose logs --tail=50 web"
  fi
}

check_helper_api_link() {
  section "HELPER ↔ API"

  if [ -S "$EXPECTED_HOST_HELPER_SOCKET_PATH" ]; then
    HOST_HELPER_SOCKET_OK=1
    ok "Host helper socket exists ($EXPECTED_HOST_HELPER_SOCKET_PATH)"
  else
    fail "Host helper socket missing at $EXPECTED_HOST_HELPER_SOCKET_PATH" "sudo systemctl restart hytale-helper.service"
  fi

  if [ -S "$LEGACY_HOST_HELPER_SOCKET_PATH" ] && [ "$LEGACY_HOST_HELPER_SOCKET_PATH" != "$EXPECTED_HOST_HELPER_SOCKET_PATH" ]; then
    LEGACY_HOST_HELPER_SOCKET_EXISTS=1
    if [ "$HOST_HELPER_SOCKET_OK" -eq 0 ]; then
      fail "Legacy helper socket $LEGACY_HOST_HELPER_SOCKET_PATH exists while stable socket is missing" "sudo systemctl restart hytale-helper.service, then remove the legacy socket"
    else
      fail "Stale legacy helper socket at $LEGACY_HOST_HELPER_SOCKET_PATH" "sudo rm -f $LEGACY_HOST_HELPER_SOCKET_PATH"
    fi
  else
    ok "No stale legacy helper socket"
  fi

  local configured_socket
  configured_socket="$(read_env_value_privileged "$HELPER_ENV_FILE" HELPER_SOCKET_PATH || true)"
  if [ "$configured_socket" = "$EXPECTED_HOST_HELPER_SOCKET_PATH" ]; then
    HELPER_ENV_SOCKET_OK=1
    ok "Helper .env HELPER_SOCKET_PATH matches stable path"
  else
    fail "Helper .env points at '${configured_socket:-<missing>}'; expected $EXPECTED_HOST_HELPER_SOCKET_PATH" "edit $HELPER_ENV_FILE and set HELPER_SOCKET_PATH=$EXPECTED_HOST_HELPER_SOCKET_PATH"
  fi

  if command -v docker >/dev/null 2>&1 && [ "$API_CONTAINER_OK" -eq 1 ]; then
    if docker_compose exec -T api test -S "$API_HELPER_SOCKET_PATH" >/dev/null 2>&1; then
      API_SEES_HELPER_SOCKET=1
      ok "API container sees helper socket at $API_HELPER_SOCKET_PATH"
    else
      fail "API container cannot see helper socket at $API_HELPER_SOCKET_PATH" "docker compose up -d --force-recreate api"
    fi
  elif [ "$API_CONTAINER_OK" -eq 0 ]; then
    warn "API container not running; skipping socket visibility check" "see earlier API container failure"
  fi

  if [ "$HOST_HELPER_SOCKET_OK" -eq 1 ]; then
    hmac_round_trip
    case $? in
      0)
        HMAC_ROUND_TRIP_OK=1
        ok "HMAC round-trip succeeds (helper.ping → pong)"
        ;;
      1)
        fail "HMAC round-trip failed — helper rejected the signature" "HELPER_HMAC_SECRET likely differs between $ROOT_ENV_FILE and $HELPER_ENV_FILE; make them match and restart api + helper"
        ;;
      2)
        warn "Helper socket missing; round-trip skipped" "see Host helper socket failure above"
        ;;
      3)
        warn "Cannot read HELPER_HMAC_SECRET from env files; round-trip skipped" "run doctor with sudo or read permission on $HELPER_ENV_FILE"
        ;;
      4)
        warn "curl or openssl unavailable; round-trip skipped" "apt-get install curl openssl"
        ;;
      *)
        fail "HMAC round-trip did not complete" "journalctl -u hytale-helper.service --no-pager -n 30"
        ;;
    esac
  else
    warn "Helper socket missing; HMAC round-trip skipped" "fix helper socket first"
  fi
}

check_database() {
  section "DATABASE"

  if [ "$POSTGRES_CONTAINER_OK" -eq 0 ]; then
    fail "postgres container not running; skipping DB checks" "docker compose up -d postgres"
    return
  fi

  if docker_compose exec -T postgres pg_isready -U hytale_panel -d hytale_panel >/dev/null 2>&1; then
    ok "postgres accepts connections"
  else
    fail "postgres does not accept connections" "docker compose logs --tail=50 postgres"
    return
  fi

  if docker_compose exec -T postgres psql -U hytale_panel -d hytale_panel -tAc 'SELECT 1' >/dev/null 2>&1; then
    ok "hytale_panel database reachable"
  else
    fail "hytale_panel database unreachable" "check DB_PASSWORD in $ROOT_ENV_FILE matches the postgres container"
    return
  fi

  local applied_raw applied_count=0 has_table=0
  if docker_compose exec -T postgres psql -U hytale_panel -d hytale_panel -tAc "SELECT 1 FROM information_schema.tables WHERE table_name='_migrations'" 2>/dev/null | tr -d ' \n' | grep -q '^1$'; then
    has_table=1
    applied_raw="$(docker_compose exec -T postgres psql -U hytale_panel -d hytale_panel -tAc 'SELECT count(*) FROM _migrations' 2>/dev/null | tr -d ' \r\n' || true)"
    [[ "$applied_raw" =~ ^[0-9]+$ ]] && applied_count="$applied_raw"
  fi

  local mig_dir="$ROOT_DIR/packages/api/src/db/migrations"
  [ ! -d "$mig_dir" ] && mig_dir="$ROOT_DIR/packages/api/dist/db/migrations"
  local file_count=0
  if [ -d "$mig_dir" ]; then
    file_count=$(find "$mig_dir" -maxdepth 1 -name '*.sql' -type f 2>/dev/null | wc -l | tr -d ' ')
  fi

  if [ "$has_table" -eq 0 ]; then
    if [ "$file_count" -gt 0 ]; then
      MIGRATIONS_PENDING_COUNT="$file_count"
      fail "No migrations applied yet (${file_count} on disk)" "docker compose exec api node dist/db/migrate.js"
    else
      warn "Cannot locate migrations directory on disk; nothing to compare" ""
    fi
  elif [ "$file_count" -eq 0 ]; then
    warn "Migrations table has ${applied_count} rows but no .sql files found on disk" "checkout may be incomplete"
  elif [ "$applied_count" -eq "$file_count" ]; then
    MIGRATIONS_CURRENT=1
    ok "Migrations current (${applied_count} applied)"
  elif [ "$applied_count" -lt "$file_count" ]; then
    MIGRATIONS_PENDING_COUNT=$((file_count - applied_count))
    fail "Migrations pending: ${applied_count}/${file_count} applied" "docker compose exec api node dist/db/migrate.js"
  else
    warn "More applied (${applied_count}) than on disk (${file_count}) — older checkout?" "verify deploy/rollback-panel.sh wasn't run against a stale ref"
  fi
}

check_config() {
  section "CONFIG"

  if [ -f "$ROOT_ENV_FILE" ]; then
    local mode
    mode="$(stat_mode "$ROOT_ENV_FILE")"
    if [ "$mode" = "600" ]; then
      ROOT_ENV_PERMS_OK=1
      ok "Root .env exists (mode 600)"
    else
      fail "Root .env mode is $mode, expected 600" "sudo chmod 600 $ROOT_ENV_FILE"
    fi
  else
    fail "Root .env missing at $ROOT_ENV_FILE" "sudo ./install.sh"
    return
  fi

  if sudo -n test -r "$HELPER_ENV_FILE" 2>/dev/null || [ -r "$HELPER_ENV_FILE" ]; then
    local mode owner
    mode="$(stat_mode "$HELPER_ENV_FILE")"
    owner="$(stat_owner "$HELPER_ENV_FILE")"
    if [ "$mode" = "640" ] && [ "$owner" = "root:$PANEL_SOCKET_GROUP" ]; then
      HELPER_ENV_PERMS_OK=1
      ok "Helper .env exists (mode 640, $owner)"
    else
      fail "Helper .env has mode=$mode owner=$owner, expected 640 root:$PANEL_SOCKET_GROUP" "sudo chown root:$PANEL_SOCKET_GROUP $HELPER_ENV_FILE && sudo chmod 640 $HELPER_ENV_FILE"
    fi
  else
    fail "Helper .env missing at $HELPER_ENV_FILE" "sudo ./install.sh"
  fi

  check_secret_length() {
    local key="$1"
    local val
    val="$(read_env_value "$ROOT_ENV_FILE" "$key" 2>/dev/null || true)"
    if [ -z "$val" ]; then
      fail "$key missing from $ROOT_ENV_FILE" "openssl rand -hex 32 and paste into $ROOT_ENV_FILE"
    elif [ "${#val}" -lt "$MIN_SECRET_LENGTH" ]; then
      fail "$key shorter than ${MIN_SECRET_LENGTH} chars (API will crash on startup)" "regenerate: openssl rand -hex 32"
    else
      ok "$key ≥ ${MIN_SECRET_LENGTH} chars"
    fi
  }
  check_secret_length SESSION_SECRET
  check_secret_length CSRF_SECRET
  check_secret_length HELPER_HMAC_SECRET

  local secret_root secret_helper
  secret_root="$(read_env_value "$ROOT_ENV_FILE" HELPER_HMAC_SECRET 2>/dev/null || true)"
  secret_helper="$(read_env_value_privileged "$HELPER_ENV_FILE" HELPER_HMAC_SECRET 2>/dev/null || true)"
  if [ -z "$secret_root" ] || [ -z "$secret_helper" ]; then
    warn "Could not compare HELPER_HMAC_SECRET between files" "run doctor with sudo to verify"
  elif [ "$secret_root" = "$secret_helper" ]; then
    ok "HELPER_HMAC_SECRET matches between root .env and helper .env"
  else
    fail "HELPER_HMAC_SECRET differs between $ROOT_ENV_FILE and $HELPER_ENV_FILE" "copy the root value into the helper .env, then sudo systemctl restart hytale-helper && docker compose up -d --force-recreate api"
  fi

  local cors ws_origins
  cors="$(read_env_value "$ROOT_ENV_FILE" CORS_ORIGIN 2>/dev/null || true)"
  ws_origins="$(read_env_value "$ROOT_ENV_FILE" WS_ALLOWED_ORIGINS 2>/dev/null || true)"
  if [ -n "$cors" ]; then ok "CORS_ORIGIN set"; else fail "CORS_ORIGIN empty in $ROOT_ENV_FILE" "set to your panel URL (e.g. https://panel.example.com)"; fi
  if [ -n "$ws_origins" ]; then ok "WS_ALLOWED_ORIGINS set"; else fail "WS_ALLOWED_ORIGINS empty in $ROOT_ENV_FILE" "set to your panel URL (same as CORS_ORIGIN in most cases)"; fi

  local gid_env gid_host
  gid_env="$(read_env_value "$ROOT_ENV_FILE" PANEL_SOCKET_GID 2>/dev/null || true)"
  gid_host="$(getent group "$PANEL_SOCKET_GROUP" | cut -d: -f3 || true)"
  if [ -n "$gid_env" ] && [ "$gid_env" = "$gid_host" ]; then
    ok "PANEL_SOCKET_GID ($gid_env) matches host group $PANEL_SOCKET_GROUP"
  elif [ -z "$gid_env" ]; then
    fail "PANEL_SOCKET_GID not set in $ROOT_ENV_FILE" "sudo ./install.sh"
  elif [ -z "$gid_host" ]; then
    fail "Host group $PANEL_SOCKET_GROUP does not exist" "sudo ./install.sh"
  else
    fail "PANEL_SOCKET_GID=$gid_env but host group $PANEL_SOCKET_GROUP has GID $gid_host" "reconcile by editing $ROOT_ENV_FILE or recreating the host group"
  fi

  local run_mode run_owner deploy_mode deploy_owner
  run_mode="$(stat_mode "$HELPER_RUNTIME_DIR")"
  run_owner="$(stat_owner "$HELPER_RUNTIME_DIR")"
  if [ "$run_mode" = "770" ] && [ "$run_owner" = "root:$PANEL_SOCKET_GROUP" ]; then
    HELPER_RUNTIME_PERMS_OK=1
    ok "$HELPER_RUNTIME_DIR is 770 root:$PANEL_SOCKET_GROUP"
  else
    fail "$HELPER_RUNTIME_DIR has mode=$run_mode owner=$run_owner, expected 770 root:$PANEL_SOCKET_GROUP" "sudo chown root:$PANEL_SOCKET_GROUP $HELPER_RUNTIME_DIR && sudo chmod 770 $HELPER_RUNTIME_DIR"
  fi

  deploy_mode="$(stat_mode "$HELPER_DEPLOY_DIR")"
  deploy_owner="$(stat_owner "$HELPER_DEPLOY_DIR")"
  if [ "$deploy_mode" = "750" ] && [ "$deploy_owner" = "root:$PANEL_SOCKET_GROUP" ]; then
    HELPER_DEPLOY_PERMS_OK=1
    ok "$HELPER_DEPLOY_DIR is 750 root:$PANEL_SOCKET_GROUP"
  else
    fail "$HELPER_DEPLOY_DIR has mode=$deploy_mode owner=$deploy_owner, expected 750 root:$PANEL_SOCKET_GROUP" "sudo chown -R root:$PANEL_SOCKET_GROUP $HELPER_DEPLOY_DIR && sudo chmod 750 $HELPER_DEPLOY_DIR"
  fi
}

check_resources() {
  section "RESOURCES"

  local root_avail_kb root_avail_gb
  if root_avail_kb="$(df -P --output=avail / 2>/dev/null | tail -n 1 | tr -d ' ')" && [[ "$root_avail_kb" =~ ^[0-9]+$ ]]; then
    root_avail_gb=$((root_avail_kb / 1024 / 1024))
    if [ "$root_avail_gb" -ge "$MIN_DISK_FREE_GB" ]; then
      ok "Root fs: ${root_avail_gb}G free"
    else
      fail "Root fs only ${root_avail_gb}G free (< ${MIN_DISK_FREE_GB}G)" "clean up logs, old docker images (docker system prune), or grow the volume"
    fi
  else
    warn "Could not read root fs free space" ""
  fi

  if [ -d "$BACKUP_PATH" ]; then
    local bk_avail_kb bk_avail_gb
    if bk_avail_kb="$(df -P --output=avail "$BACKUP_PATH" 2>/dev/null | tail -n 1 | tr -d ' ')" && [[ "$bk_avail_kb" =~ ^[0-9]+$ ]]; then
      bk_avail_gb=$((bk_avail_kb / 1024 / 1024))
      if [ "$bk_avail_gb" -ge "$MIN_DISK_FREE_GB" ]; then
        ok "$BACKUP_PATH: ${bk_avail_gb}G free"
      else
        fail "$BACKUP_PATH only ${bk_avail_gb}G free (< ${MIN_DISK_FREE_GB}G)" "prune old backups or grow the volume"
      fi
    fi
  else
    warn "$BACKUP_PATH does not exist; skipping" "sudo mkdir -p $BACKUP_PATH && sudo chown hytale:hytale $BACKUP_PATH && sudo chmod 770 $BACKUP_PATH"
  fi

  local mem_avail_mb mem_total_mb
  if mem_avail_mb="$(free -m 2>/dev/null | awk '/^Mem:/ {print $7}')" && [[ "$mem_avail_mb" =~ ^[0-9]+$ ]]; then
    mem_total_mb="$(free -m 2>/dev/null | awk '/^Mem:/ {print $2}')"
    if [ "$mem_avail_mb" -ge "$MIN_MEMORY_FREE_MB" ]; then
      ok "Memory: ${mem_avail_mb}M available${mem_total_mb:+ of ${mem_total_mb}M}"
    else
      fail "Memory: only ${mem_avail_mb}M available (< ${MIN_MEMORY_FREE_MB}M)" "check top consumers; panel API default limit is 512M — may need a larger VPS"
    fi
  else
    warn "Could not read memory info" ""
  fi
}

check_hytale_world() {
  section "HYTALE WORLD"

  if [ -d "$HYTALE_ROOT" ]; then
    if sudo -n test -r "$HYTALE_ROOT" 2>/dev/null || [ -r "$HYTALE_ROOT" ]; then
      ok "HYTALE_ROOT readable ($HYTALE_ROOT)"
    else
      fail "HYTALE_ROOT exists but not readable by this user ($HYTALE_ROOT)" "sudo chown -R hytale:hytale $HYTALE_ROOT"
    fi
  else
    fail "HYTALE_ROOT missing ($HYTALE_ROOT)" "install the Hytale server files at $HYTALE_ROOT, or edit HYTALE_ROOT in $HELPER_ENV_FILE"
  fi

  for entry in "whitelist:$WHITELIST_PATH:file" "bans:$BANS_PATH:file" "worlds:$WORLDS_PATH:dir"; do
    local label path kind
    label="${entry%%:*}"
    path="${entry#*:}"; path="${path%:*}"
    kind="${entry##*:}"
    if [ "$kind" = "file" ]; then
      if sudo -n test -r "$path" 2>/dev/null || [ -r "$path" ]; then
        ok "$label readable ($path)"
      elif sudo -n test -e "$path" 2>/dev/null || [ -e "$path" ]; then
        fail "$label exists but not readable ($path)" "sudo chown hytale:hytale $path"
      else
        warn "$label file not present ($path)" "created on first whitelist/ban write if the server is online"
      fi
    else
      if sudo -n test -d "$path" 2>/dev/null || [ -d "$path" ]; then
        ok "$label/ directory exists ($path)"
      else
        fail "$label/ directory missing ($path)" "ensure Hytale server is installed and WORLDS_PATH points at the right directory"
      fi
    fi
  done

  if [ -S "$TMUX_SOCKET_PATH" ]; then
    TMUX_SOCKET_EXISTS=1
    ok "tmux shared socket exists ($TMUX_SOCKET_PATH)"
  else
    warn "tmux shared socket missing ($TMUX_SOCKET_PATH)" "sudo systemctl restart hytale-tmux.service"
  fi

  if [ -d "$HYTALE_TMP_DIR" ] && sudo -n -u hytale test -w "$HYTALE_TMP_DIR" 2>/dev/null; then
    HYTALE_TMP_READY=1
    ok "Hytale temp dir writable ($HYTALE_TMP_DIR)"
  else
    fail "Hytale temp dir not ready ($HYTALE_TMP_DIR)" "sudo install -d -o hytale -g hytale -m 0770 $HYTALE_TMP_DIR"
  fi

  if tmux_session_exists; then
    TMUX_SESSION_EXISTS=1
    ok "tmux session '$TMUX_SESSION' present on shared socket"
  else
    warn "tmux session '$TMUX_SESSION' not present" "normal if the game is stopped; otherwise: sudo systemctl restart hytale-tmux.service"
  fi

  JAVA_PROCESS_SUMMARY="$(find_hytale_java || true)"
  if [ -n "$JAVA_PROCESS_SUMMARY" ]; then
    JAVA_PROCESS_EXISTS=1
    ok "Hytale Java process detected"
    [ "$VERBOSE" -eq 1 ] && printf '    %s%s%s\n' "$COLOR_DIM" "$JAVA_PROCESS_SUMMARY" "$COLOR_RESET"
  else
    warn "No Hytale Java process detected" "start the game via systemctl restart hytale-tmux.service"
  fi

  if [ "$TMUX_SESSION_EXISTS" -eq 1 ] && [ "$JAVA_PROCESS_EXISTS" -eq 1 ]; then
    ok "Runtime consistent: tmux + Java both present"
  elif [ "$TMUX_SESSION_EXISTS" -eq 1 ] && [ "$JAVA_PROCESS_EXISTS" -eq 0 ]; then
    fail "Stale tmux session: no Java process attached" "sudo -u hytale tmux -S $TMUX_SOCKET_PATH kill-session -t $TMUX_SESSION, then restart hytale-tmux.service"
  elif [ "$TMUX_SESSION_EXISTS" -eq 0 ] && [ "$JAVA_PROCESS_EXISTS" -eq 1 ]; then
    fail "Orphan Java process: running without managed tmux session" "kill the orphan and restart hytale-tmux.service"
  elif [ "$GAME_SERVICE_ACTIVE" -eq 1 ] || [ "$GAME_SERVICE_FAILED" -eq 1 ]; then
    fail "Systemd thinks game is active/failed but no runtime exists" "sudo systemctl reset-failed hytale-tmux.service && sudo systemctl restart hytale-tmux.service"
  fi
}

run_checks() {
  failures=0
  warnings=0
  checks=0

  HELPER_SERVICE_ACTIVE=0
  HELPER_UNIT_CONFIG_OK=0
  HELPER_ENV_SOCKET_OK=0
  HELPER_OVERRIDE_CLEAN=0
  HELPER_RUNTIME_DIRECT_EXEC_OK=0
  LEGACY_SERVICE_RETIRED=0
  HOST_HELPER_SOCKET_OK=0
  LEGACY_HOST_HELPER_SOCKET_EXISTS=0
  API_SEES_HELPER_SOCKET=0
  API_HEALTH_OK=0
  WEB_PROXY_OK=0
  HMAC_ROUND_TRIP_OK=0
  POSTGRES_CONTAINER_OK=0
  API_CONTAINER_OK=0
  WEB_CONTAINER_OK=0
  MIGRATIONS_CURRENT=0
  MIGRATIONS_PENDING_COUNT=0
  ROOT_ENV_PERMS_OK=0
  HELPER_ENV_PERMS_OK=0
  HELPER_DEPLOY_PERMS_OK=0
  HELPER_RUNTIME_PERMS_OK=0
  HYTALE_TMP_READY=0
  TMUX_SOCKET_EXISTS=0
  TMUX_SESSION_EXISTS=0
  JAVA_PROCESS_EXISTS=0
  JAVA_PROCESS_SUMMARY=""
  GAME_SERVICE_ACTIVE=0
  GAME_SERVICE_FAILED=0

  check_services
  check_network
  check_helper_api_link
  check_database
  check_config
  check_resources
  check_hytale_world
}

# ─── Fixes (safe auto-repair) ──────────────────────────────
perform_fixes() {
  printf '\n%sAPPLYING SAFE FIXES%s\n' "$COLOR_BLUE" "$COLOR_RESET"

  if [ "$LEGACY_SERVICE_RETIRED" -eq 0 ]; then
    if sudo systemctl disable --now hytale.service >/dev/null 2>&1; then
      printf '  %s✓%s disabled legacy hytale.service\n' "$COLOR_GREEN" "$COLOR_RESET"
      repairs=$((repairs + 1))
    fi
  fi

  if [ -f "$HELPER_OVERRIDE_FILE" ]; then
    if sudo rm -f "$HELPER_OVERRIDE_FILE" && { sudo rmdir "$HELPER_OVERRIDE_DIR" >/dev/null 2>&1 || true; }; then
      printf '  %s✓%s removed stale helper override.conf\n' "$COLOR_GREEN" "$COLOR_RESET"
      repairs=$((repairs + 1))
      sudo systemctl daemon-reload >/dev/null 2>&1 || true
    fi
  fi

  if [ "$HELPER_UNIT_CONFIG_OK" -eq 0 ] && [ -f "$ROOT_DIR/systemd/hytale-helper.service" ]; then
    if sudo cp "$ROOT_DIR/systemd/hytale-helper.service" /etc/systemd/system/hytale-helper.service; then
      printf '  %s✓%s reinstalled shipped hytale-helper.service unit\n' "$COLOR_GREEN" "$COLOR_RESET"
      repairs=$((repairs + 1))
      sudo systemctl daemon-reload >/dev/null 2>&1 || true
    fi
  fi

  if [ "$HELPER_ENV_SOCKET_OK" -eq 0 ] && [ -f "$HELPER_ENV_FILE" ]; then
    if sudo sed -i -E "s|^HELPER_SOCKET_PATH=.*|HELPER_SOCKET_PATH=${EXPECTED_HOST_HELPER_SOCKET_PATH}|" "$HELPER_ENV_FILE" &&
       sudo chown "root:$PANEL_SOCKET_GROUP" "$HELPER_ENV_FILE" &&
       sudo chmod 640 "$HELPER_ENV_FILE"; then
      printf '  %s✓%s fixed HELPER_SOCKET_PATH in helper .env\n' "$COLOR_GREEN" "$COLOR_RESET"
      repairs=$((repairs + 1))
    fi
  fi

  if [ "$ROOT_ENV_PERMS_OK" -eq 0 ] && [ -f "$ROOT_ENV_FILE" ]; then
    if sudo chmod 600 "$ROOT_ENV_FILE"; then
      printf '  %s✓%s set $ROOT_ENV_FILE mode to 600\n' "$COLOR_GREEN" "$COLOR_RESET"
      repairs=$((repairs + 1))
    fi
  fi

  if [ "$HELPER_ENV_PERMS_OK" -eq 0 ] && [ -f "$HELPER_ENV_FILE" ]; then
    if sudo chown "root:$PANEL_SOCKET_GROUP" "$HELPER_ENV_FILE" && sudo chmod 640 "$HELPER_ENV_FILE"; then
      printf '  %s✓%s reset helper .env to 640 root:%s\n' "$COLOR_GREEN" "$COLOR_RESET" "$PANEL_SOCKET_GROUP"
      repairs=$((repairs + 1))
    fi
  fi

  if [ "$HELPER_RUNTIME_PERMS_OK" -eq 0 ] && [ -d "$HELPER_RUNTIME_DIR" ]; then
    if sudo chown "root:$PANEL_SOCKET_GROUP" "$HELPER_RUNTIME_DIR" && sudo chmod 770 "$HELPER_RUNTIME_DIR"; then
      printf '  %s✓%s reset %s to 770 root:%s\n' "$COLOR_GREEN" "$COLOR_RESET" "$HELPER_RUNTIME_DIR" "$PANEL_SOCKET_GROUP"
      repairs=$((repairs + 1))
    fi
  fi

  if [ "$HELPER_DEPLOY_PERMS_OK" -eq 0 ] && [ -d "$HELPER_DEPLOY_DIR" ]; then
    if sudo chown -R "root:$PANEL_SOCKET_GROUP" "$HELPER_DEPLOY_DIR" && sudo chmod 750 "$HELPER_DEPLOY_DIR"; then
      printf '  %s✓%s reset %s to 750 root:%s\n' "$COLOR_GREEN" "$COLOR_RESET" "$HELPER_DEPLOY_DIR" "$PANEL_SOCKET_GROUP"
      repairs=$((repairs + 1))
    fi
  fi

  if [ "$HYTALE_TMP_READY" -eq 0 ]; then
    if sudo install -d -o hytale -g hytale -m 0770 "$HYTALE_TMP_DIR"; then
      printf '  %s✓%s created Hytale temp dir (%s)\n' "$COLOR_GREEN" "$COLOR_RESET" "$HYTALE_TMP_DIR"
      repairs=$((repairs + 1))
    fi
  fi

  if [ "$LEGACY_HOST_HELPER_SOCKET_EXISTS" -eq 1 ] && [ -S "$EXPECTED_HOST_HELPER_SOCKET_PATH" ]; then
    if sudo rm -f "$LEGACY_HOST_HELPER_SOCKET_PATH"; then
      printf '  %s✓%s removed stale legacy helper socket\n' "$COLOR_GREEN" "$COLOR_RESET"
      repairs=$((repairs + 1))
    fi
  fi

  if [ "$HELPER_SERVICE_ACTIVE" -eq 0 ] || [ "$HELPER_UNIT_CONFIG_OK" -eq 0 ] || [ "$HELPER_ENV_SOCKET_OK" -eq 0 ] || [ "$HOST_HELPER_SOCKET_OK" -eq 0 ]; then
    if sudo systemctl restart hytale-helper.service >/dev/null 2>&1; then
      printf '  %s✓%s restarted hytale-helper.service\n' "$COLOR_GREEN" "$COLOR_RESET"
      repairs=$((repairs + 1))
    fi
  fi

  if command -v docker >/dev/null 2>&1; then
    local recreate_api=0
    [ "$API_CONTAINER_OK" -eq 0 ] && recreate_api=1
    [ "$API_SEES_HELPER_SOCKET" -eq 0 ] && recreate_api=1

    if [ "$POSTGRES_CONTAINER_OK" -eq 0 ]; then
      if docker_compose up -d postgres >/dev/null 2>&1; then
        printf '  %s✓%s started postgres container\n' "$COLOR_GREEN" "$COLOR_RESET"
        repairs=$((repairs + 1))
      fi
    fi

    if [ "$WEB_CONTAINER_OK" -eq 0 ]; then
      if docker_compose up -d web >/dev/null 2>&1; then
        printf '  %s✓%s started web container\n' "$COLOR_GREEN" "$COLOR_RESET"
        repairs=$((repairs + 1))
      fi
    fi

    if [ "$recreate_api" -eq 1 ]; then
      if docker_compose up -d --force-recreate api >/dev/null 2>&1; then
        printf '  %s✓%s recreated api container\n' "$COLOR_GREEN" "$COLOR_RESET"
        repairs=$((repairs + 1))
      fi
    fi

    if [ "$MIGRATIONS_PENDING_COUNT" -gt 0 ] && [ "$API_CONTAINER_OK" -eq 1 ]; then
      if docker_compose exec -T api node dist/db/migrate.js >/dev/null 2>&1; then
        printf '  %s✓%s applied pending migrations\n' "$COLOR_GREEN" "$COLOR_RESET"
        repairs=$((repairs + 1))
      fi
    fi
  fi

  if [ "$TMUX_SESSION_EXISTS" -eq 1 ] && [ "$JAVA_PROCESS_EXISTS" -eq 0 ]; then
    if sudo -n -u hytale tmux -S "$TMUX_SOCKET_PATH" kill-session -t "$TMUX_SESSION" >/dev/null 2>&1; then
      printf '  %s✓%s cleared stale tmux session\n' "$COLOR_GREEN" "$COLOR_RESET"
      repairs=$((repairs + 1))
    fi
  fi

  if [ "$GAME_SERVICE_FAILED" -eq 1 ]; then
    if sudo systemctl reset-failed hytale-tmux.service >/dev/null 2>&1 && sudo systemctl restart hytale-tmux.service >/dev/null 2>&1; then
      printf '  %s✓%s reset and restarted hytale-tmux.service\n' "$COLOR_GREEN" "$COLOR_RESET"
      repairs=$((repairs + 1))
    fi
  fi
}

# ─── Main ──────────────────────────────────────────────────
printf '%sHytale Panel Doctor%s  (fix: %s)\n' "$COLOR_BLUE" "$COLOR_RESET" "$([ "$FIX" -eq 1 ] && echo on || echo off)"
printf '%sConfiguration:%s\n' "$COLOR_DIM" "$COLOR_RESET"
printf '  helper socket:  %s\n' "$EXPECTED_HOST_HELPER_SOCKET_PATH"
printf '  api port:       %s\n' "$API_HOST_PORT"
printf '  web port:       %s\n' "$WEB_HOST_PORT"
printf '  postgres port:  %s\n' "$POSTGRES_HOST_PORT"
printf '  hytale root:    %s\n' "$HYTALE_ROOT"

run_checks

if [ "$FIX" -eq 1 ] && [ "$failures" -gt 0 ]; then
  perform_fixes
  printf '\n%sRe-running checks after fixes%s\n' "$COLOR_DIM" "$COLOR_RESET"
  run_checks
fi

printf '\n%sSummary%s: %d checks, %s%d failures%s, %s%d warnings%s' \
  "$COLOR_BLUE" "$COLOR_RESET" "$checks" \
  "$([ "$failures" -gt 0 ] && printf '%s' "$COLOR_RED" || printf '%s' "$COLOR_GREEN")" "$failures" "$COLOR_RESET" \
  "$([ "$warnings" -gt 0 ] && printf '%s' "$COLOR_YELLOW" || printf '%s' "")" "$warnings" "$COLOR_RESET"
if [ "$FIX" -eq 1 ]; then
  printf ', %d repairs' "$repairs"
fi
printf '\n'

if [ "$failures" -gt 0 ]; then
  exit 1
fi
