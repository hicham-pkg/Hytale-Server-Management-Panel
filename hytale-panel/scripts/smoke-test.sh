#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT_ENV_FILE="$ROOT_DIR/.env"
HELPER_ENV_FILE="/opt/hytale-panel/helper/.env"
EXPECTED_HELPER_SOCKET_PATH="/opt/hytale-panel/run/hytale-helper.sock"
LEGACY_HELPER_SOCKET_PATH="/run/hytale-helper/hytale-helper.sock"
HYTALE_TMP_DIR="/opt/hytale/tmp"

read_env_value_from_file() {
  local file="$1"
  local key="$2"
  local value

  if [ ! -r "$file" ]; then
    return 1
  fi

  value="$(grep -E "^${key}=" "$file" | tail -n 1 | cut -d= -f2- || true)"
  value="${value%$'\r'}"
  value="${value#\"}"
  value="${value%\"}"

  if [ -n "$value" ]; then
    printf '%s' "$value"
    return 0
  fi

  return 1
}

read_env_value() {
  local key="$1"
  read_env_value_from_file "$ROOT_ENV_FILE" "$key"
}

WEB_HOST_PORT="${WEB_HOST_PORT:-$(read_env_value WEB_HOST_PORT || true)}"
WEB_HOST_PORT="${WEB_HOST_PORT:-3000}"
API_HOST_PORT="${API_HOST_PORT:-$(read_env_value API_HOST_PORT || true)}"
API_HOST_PORT="${API_HOST_PORT:-4000}"
POSTGRES_HOST_PORT="${POSTGRES_HOST_PORT:-$(read_env_value POSTGRES_HOST_PORT || true)}"
POSTGRES_HOST_PORT="${POSTGRES_HOST_PORT:-5432}"
CONFIGURED_HELPER_SOCKET_PATH="${HELPER_SOCKET_PATH:-$(read_env_value_from_file "$HELPER_ENV_FILE" HELPER_SOCKET_PATH || true)}"
CONFIGURED_HELPER_SOCKET_PATH="${CONFIGURED_HELPER_SOCKET_PATH:-$EXPECTED_HELPER_SOCKET_PATH}"
HELPER_SOCKET_PATH="$EXPECTED_HELPER_SOCKET_PATH"
API_HELPER_SOCKET_PATH="/run/hytale-helper/hytale-helper.sock"
TMUX_SOCKET_PATH="${TMUX_SOCKET_PATH:-/opt/hytale/run/hytale.tmux.sock}"

failures=0

docker_compose() {
  if docker info >/dev/null 2>&1; then
    docker compose "$@"
    return $?
  fi

  if command -v sudo >/dev/null 2>&1 && sudo docker info >/dev/null 2>&1; then
    sudo docker compose "$@"
    return $?
  fi

  return 1
}

check() {
  local description="$1"
  shift

  if "$@"; then
    printf '[OK] %s\n' "$description"
  else
    printf '[FAIL] %s\n' "$description"
    failures=$((failures + 1))
  fi
}

echo "Hytale Panel smoke test"
echo "  CONFIGURED_HELPER_SOCKET_PATH=${CONFIGURED_HELPER_SOCKET_PATH}"
echo "  EXPECTED_HELPER_SOCKET_PATH=${HELPER_SOCKET_PATH}"
echo "  TMUX_SOCKET_PATH=${TMUX_SOCKET_PATH}"
echo "  HYTALE_TMP_DIR=${HYTALE_TMP_DIR}"
echo "  API_HOST_PORT=${API_HOST_PORT}"
echo "  WEB_HOST_PORT=${WEB_HOST_PORT}"
echo "  POSTGRES_HOST_PORT=${POSTGRES_HOST_PORT}"
echo ""

check "helper .env points at the stable host socket path" test "$CONFIGURED_HELPER_SOCKET_PATH" = "$HELPER_SOCKET_PATH"
check "stable helper socket exists" test -S "$HELPER_SOCKET_PATH"
check "Hytale temp directory exists" test -d "$HYTALE_TMP_DIR"
if [ -S "$LEGACY_HELPER_SOCKET_PATH" ] && [ "$LEGACY_HELPER_SOCKET_PATH" != "$HELPER_SOCKET_PATH" ]; then
  printf '[FAIL] stale legacy helper socket still exists at %s\n' "$LEGACY_HELPER_SOCKET_PATH"
  failures=$((failures + 1))
fi
check "game server tmux socket exists" test -S "$TMUX_SOCKET_PATH"
check "api health responds directly" curl -fsS "http://127.0.0.1:${API_HOST_PORT}/api/health"
check "web proxy reaches api health" curl -fsS "http://127.0.0.1:${WEB_HOST_PORT}/api/health"

if command -v sudo >/dev/null 2>&1; then
  check "game server tmux session visible on shared socket" sudo -u hytale tmux -S "$TMUX_SOCKET_PATH" has-session -t hytale
  check "Hytale temp directory is writable by hytale" sudo -u hytale test -w "$HYTALE_TMP_DIR"
else
  printf '[WARN] sudo not found; skipping tmux session check\n'
fi

if command -v docker >/dev/null 2>&1; then
  check "docker compose can report service status" docker_compose ps
  check "api container can see helper socket" docker_compose exec -T api test -S "$API_HELPER_SOCKET_PATH"
else
  printf '[WARN] docker not found; skipping docker compose ps\n'
fi

echo ""
echo "Migration command:"
echo "  docker compose exec api node dist/db/migrate.js"

if [ "$failures" -gt 0 ]; then
  exit 1
fi
