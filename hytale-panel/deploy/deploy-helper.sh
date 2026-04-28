#!/bin/bash
# ============================================================
# Hytale Panel — Helper Service Deployment Script
# ============================================================
# Builds and deploys the helper service to /opt/hytale-panel/helper/
#
# Usage: sudo ./deploy/deploy-helper.sh
#
# This script:
#   1. Installs workspace dependencies via pnpm
#   2. Builds the shared package
#   3. Builds the helper package
#   4. Copies built files to /opt/hytale-panel/helper/
#   5. Sets correct ownership
#   6. Restarts the helper service
#
# Prerequisites:
#   - pnpm 9+ installed (this repo uses pnpm workspaces)
#   - Node.js 20+
# ============================================================

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info()  { echo -e "[INFO] $1"; }
log_ok()    { echo -e "${GREEN}[OK]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

read_env_value() {
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

if [ "$EUID" -ne 0 ]; then
  log_error "Please run as root: sudo ./deploy/deploy-helper.sh"
  exit 1
fi

# Verify pnpm is available
if command -v pnpm &>/dev/null; then
  PNPM_CMD=(pnpm)
else
  PNPM_CMD=(npx -y pnpm@9.15.4)
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_DIR="/opt/hytale-panel/helper"
PANEL_SOCKET_GROUP="hytale-panel"
HELPER_USER="hytale-helper"
ROOT_ENV_FILE="$SCRIPT_DIR/.env"
HELPER_ENV_FILE="/opt/hytale-panel/helper/.env"
HELPER_WRAPPER_DIR="/usr/local/lib/hytale-panel"
HELPER_JOURNALCTL_WRAPPER="${HELPER_WRAPPER_DIR}/hytale-helper-journalctl"
MOD_UPLOAD_STAGING_DIR="/opt/hytale-panel-data/mod-upload-staging"
MODS_DIR="/opt/hytale/mods"
DISABLED_MODS_DIR="/opt/hytale/mods-disabled"
MOD_BACKUP_DIR="/opt/hytale/mod-backups"
HOST_HELPER_RUNTIME_DIR="/opt/hytale-panel/run"
HOST_HELPER_SOCKET_PATH="${HOST_HELPER_RUNTIME_DIR}/hytale-helper.sock"
LEGACY_HELPER_SOCKET_PATH="/run/hytale-helper/hytale-helper.sock"
API_HELPER_SOCKET_PATH="/run/hytale-helper/hytale-helper.sock"
HELPER_OVERRIDE_DIR="/etc/systemd/system/hytale-helper.service.d"
HELPER_OVERRIDE_FILE="${HELPER_OVERRIDE_DIR}/override.conf"
HELPER_SUDOERS_FILE="/etc/sudoers.d/hytale-helper"
API_HOST_PORT="${API_HOST_PORT:-$(read_env_value "$ROOT_ENV_FILE" API_HOST_PORT || true)}"
API_HOST_PORT="${API_HOST_PORT:-4000}"
STAGING_DIR="$(mktemp -d /tmp/hytale-helper-deploy.XXXXXX)"
trap 'rm -rf "$STAGING_DIR"' EXIT

set_env_var() {
  local file="$1"
  local key="$2"
  local value="$3"
  local escaped

  escaped="$(printf '%s' "$value" | sed -e 's/[\/&]/\\&/g')"

  if grep -q "^${key}=" "$file"; then
    sed -i "s|^${key}=.*|${key}=${escaped}|" "$file"
  else
    printf '\n%s=%s\n' "$key" "$value" >> "$file"
  fi
}

ensure_env_var_if_missing() {
  local file="$1"
  local key="$2"
  local value="$3"

  if ! grep -q "^${key}=" "$file"; then
    set_env_var "$file" "$key" "$value"
  fi
}

ensure_helper_user() {
  if ! getent group "$PANEL_SOCKET_GROUP" >/dev/null; then
    log_error "Missing group $PANEL_SOCKET_GROUP. Run sudo ./install.sh first."
    exit 1
  fi

  if ! getent group hytale >/dev/null; then
    log_error "Missing group hytale. Run sudo ./install.sh first."
    exit 1
  fi

  if ! id "$HELPER_USER" >/dev/null 2>&1; then
    useradd -r -d "$DEPLOY_DIR" -s /usr/sbin/nologin -g "$PANEL_SOCKET_GROUP" -G hytale "$HELPER_USER"
    log_ok "Created user: $HELPER_USER"
  else
    usermod -g "$PANEL_SOCKET_GROUP" -aG hytale "$HELPER_USER"
    log_ok "User $HELPER_USER is present"
  fi
}

prepare_mod_directories() {
  mkdir -p "$MOD_UPLOAD_STAGING_DIR" "$MODS_DIR" "$DISABLED_MODS_DIR" "$MOD_BACKUP_DIR"
  chown 1000:"$PANEL_SOCKET_GROUP" "$MOD_UPLOAD_STAGING_DIR"
  chmod 2770 "$MOD_UPLOAD_STAGING_DIR"
  chown hytale:hytale "$MODS_DIR" "$DISABLED_MODS_DIR" "$MOD_BACKUP_DIR"
  chmod 2770 "$MODS_DIR" "$DISABLED_MODS_DIR" "$MOD_BACKUP_DIR"
}

wait_for_socket() {
  local socket_path="$1"
  local description="$2"
  local attempts="${3:-30}"

  for _ in $(seq 1 "$attempts"); do
    if [ -S "$socket_path" ]; then
      log_ok "$description"
      return 0
    fi
    sleep 1
  done

  log_error "$description"
  return 1
}

wait_for_api_socket_mount() {
  local attempts="${1:-30}"

  for _ in $(seq 1 "$attempts"); do
    if docker compose exec -T api test -S "$API_HELPER_SOCKET_PATH" >/dev/null 2>&1; then
      log_ok "API container can see the helper socket"
      return 0
    fi
    sleep 1
  done

  log_error "API container still cannot see $API_HELPER_SOCKET_PATH after recreate"
  return 1
}

wait_for_http() {
  local url="$1"
  local description="$2"
  local attempts="${3:-60}"

  for _ in $(seq 1 "$attempts"); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      log_ok "$description"
      return 0
    fi
    sleep 1
  done

  log_error "$description"
  return 1
}

retire_legacy_helper_override() {
  if [ -f "$HELPER_OVERRIDE_FILE" ]; then
    rm -f "$HELPER_OVERRIDE_FILE"
    log_ok "Removed stale hytale-helper.service override.conf"
  fi

  if [ -d "$HELPER_OVERRIDE_DIR" ] && [ -z "$(ls -A "$HELPER_OVERRIDE_DIR" 2>/dev/null)" ]; then
    rmdir "$HELPER_OVERRIDE_DIR"
    log_ok "Removed empty hytale-helper.service.d directory"
  fi
}

migrate_helper_env_socket_path() {
  local current_socket_path

  mkdir -p "$HOST_HELPER_RUNTIME_DIR"
  chown "$HELPER_USER:$PANEL_SOCKET_GROUP" "$HOST_HELPER_RUNTIME_DIR"
  chmod 770 "$HOST_HELPER_RUNTIME_DIR"

  if [ ! -f "$HELPER_ENV_FILE" ]; then
    log_warn "Helper .env is missing; run sudo ./install.sh first."
    return 1
  fi

  current_socket_path="$(read_env_value "$HELPER_ENV_FILE" HELPER_SOCKET_PATH || true)"
  if [ -n "$current_socket_path" ] && [ "$current_socket_path" != "$HOST_HELPER_SOCKET_PATH" ]; then
    log_info "Migrating helper HELPER_SOCKET_PATH from $current_socket_path to $HOST_HELPER_SOCKET_PATH"
  fi

  set_env_var "$HELPER_ENV_FILE" HELPER_SOCKET_PATH "$HOST_HELPER_SOCKET_PATH"
  ensure_env_var_if_missing "$HELPER_ENV_FILE" MODS_PATH "$MODS_DIR"
  ensure_env_var_if_missing "$HELPER_ENV_FILE" DISABLED_MODS_PATH "$DISABLED_MODS_DIR"
  ensure_env_var_if_missing "$HELPER_ENV_FILE" MOD_UPLOAD_STAGING_PATH "$MOD_UPLOAD_STAGING_DIR"
  ensure_env_var_if_missing "$HELPER_ENV_FILE" MOD_BACKUP_PATH "$MOD_BACKUP_DIR"
  ensure_env_var_if_missing "$HELPER_ENV_FILE" MOD_BACKUP_RETENTION 10
  chown root:"$PANEL_SOCKET_GROUP" "$HELPER_ENV_FILE"
  chmod 640 "$HELPER_ENV_FILE"
}

remove_legacy_helper_socket_if_safe() {
  if [ "$LEGACY_HELPER_SOCKET_PATH" = "$HOST_HELPER_SOCKET_PATH" ]; then
    return 0
  fi

  if [ -S "$LEGACY_HELPER_SOCKET_PATH" ] && [ -S "$HOST_HELPER_SOCKET_PATH" ]; then
    rm -f "$LEGACY_HELPER_SOCKET_PATH"
    log_ok "Removed stale legacy helper socket at $LEGACY_HELPER_SOCKET_PATH"
  fi
}

install_helper_sudoers() {
  install -d -o root -g root -m 0755 "$HELPER_WRAPPER_DIR"
  install -o root -g root -m 0755 "$SCRIPT_DIR/systemd/hytale-helper-journalctl" "$HELPER_JOURNALCTL_WRAPPER"

  cp "$SCRIPT_DIR/systemd/hytale-helper.sudoers" "$HELPER_SUDOERS_FILE"
  chown root:root "$HELPER_SUDOERS_FILE"
  chmod 440 "$HELPER_SUDOERS_FILE"

  if command -v visudo >/dev/null 2>&1; then
    visudo -cf "$HELPER_SUDOERS_FILE" >/dev/null
  fi
}

echo ""
echo "============================================"
echo "  Helper Service Deployment"
echo "============================================"
echo ""

# ─── Install workspace dependencies ────────────────────────
log_info "Installing workspace dependencies..."
cd "$SCRIPT_DIR"
"${PNPM_CMD[@]}" install --frozen-lockfile 2>&1 | tail -3
log_ok "Dependencies installed"

# ─── Build shared package ──────────────────────────────────
log_info "Building shared package..."
"${PNPM_CMD[@]}" --filter @hytale-panel/shared build 2>&1 | tail -1
log_ok "Shared package built"

# ─── Build helper package ──────────────────────────────────
log_info "Building helper package..."
"${PNPM_CMD[@]}" --filter @hytale-panel/helper build 2>&1 | tail -1
log_ok "Helper package built"

# ─── Deploy ────────────────────────────────────────────────
log_info "Deploying to $DEPLOY_DIR..."

rm -rf "$STAGING_DIR"
mkdir -p "$STAGING_DIR"
"${PNPM_CMD[@]}" --filter @hytale-panel/helper --prod deploy "$STAGING_DIR"
rm -rf "$STAGING_DIR/node_modules/.pnpm/node_modules/@hytale-panel/helper"

rm -rf "$DEPLOY_DIR/dist" "$DEPLOY_DIR/node_modules" "$DEPLOY_DIR/package.json"
cp -R "$STAGING_DIR/dist" "$DEPLOY_DIR/"
cp -R "$STAGING_DIR/node_modules" "$DEPLOY_DIR/"
cp "$STAGING_DIR/package.json" "$DEPLOY_DIR/"

# Set ownership
chown -R root:"$PANEL_SOCKET_GROUP" "$DEPLOY_DIR"

log_ok "Files deployed"

# ─── Restart service ───────────────────────────────────────
log_info "Refreshing the shipped helper unit and migrating older installs..."
cp "$SCRIPT_DIR/systemd/hytale-helper.service" /etc/systemd/system/
ensure_helper_user
prepare_mod_directories
install_helper_sudoers
retire_legacy_helper_override
migrate_helper_env_socket_path
systemctl daemon-reload

log_info "Restarting helper service..."
systemctl restart hytale-helper.service

if systemctl is-active --quiet hytale-helper.service; then
  log_ok "Helper service is running"
else
  log_error "Helper service failed to start"
  echo "Check logs: journalctl -u hytale-helper.service --no-pager -n 20"
  exit 1
fi

wait_for_socket "$HOST_HELPER_SOCKET_PATH" "Host helper socket recreated at $HOST_HELPER_SOCKET_PATH" 30

remove_legacy_helper_socket_if_safe

if command -v docker >/dev/null 2>&1; then
  log_info "Refreshing API container so the helper socket bind is guaranteed current..."
  docker compose up -d --force-recreate api >/dev/null

  log_info "Waiting for API health on 127.0.0.1:${API_HOST_PORT}..."
  wait_for_api_socket_mount 30
  wait_for_http "http://127.0.0.1:${API_HOST_PORT}/api/health" "API health check passed" 60
else
  log_warn "docker is not installed here; skipping API container refresh"
fi

echo ""
echo "============================================"
echo "  Deployment Complete!"
echo "============================================"
echo ""
