#!/bin/bash
# ============================================================
# Hytale Server Management Panel — Ubuntu Installation Script
# ============================================================
# This script sets up the panel on a fresh Ubuntu 22.04+ VPS.
# It creates users, directories, installs systemd units, generates
# secrets, and prepares everything for Docker Compose deployment.
#
# Usage: sudo ./install.sh [-y|--yes|--non-interactive]
#
# What this script does:
#   1. Installs system dependencies (tmux, docker, curl, openssl, pnpm)
#   2. Creates the hytale user and keeps the legacy hytale-helper account aligned if present
#   3. Detects or prompts for the Hytale game server directory
#   4. Sets up directories with correct permissions
#   5. Installs systemd service units
#   6. Retires legacy helper sudoers rules and stale manual drop-ins
#   7. Generates cryptographic secrets
#   8. Deploys the helper service, reloads systemd, brings up containers, runs migrations
#   9. Runs scripts/doctor.sh to verify the installation is healthy
#
# What this script does NOT do:
#   - Install the Hytale game server (you must do that separately)
#   - Set up a reverse proxy (see docs/reverse-proxy.md)
#   - Invent admin credentials automatically without either interactive input or ADMIN_USERNAME/ADMIN_PASSWORD
# ============================================================

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info()  { echo -e "${BLUE}[INFO]${NC} $1"; }
log_ok()    { echo -e "${GREEN}[OK]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

PANEL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PANEL_SOCKET_GROUP="hytale-panel"
DEFAULT_PANEL_SOCKET_GID=2001
HELPER_RUNTIME_DIR="/opt/hytale-panel/run"
HELPER_ENV_FILE="/opt/hytale-panel/helper/.env"
STABLE_HELPER_SOCKET_PATH="${HELPER_RUNTIME_DIR}/hytale-helper.sock"
LEGACY_HELPER_SOCKET_PATH="/run/hytale-helper/hytale-helper.sock"
HELPER_OVERRIDE_DIR="/etc/systemd/system/hytale-helper.service.d"
HELPER_OVERRIDE_FILE="${HELPER_OVERRIDE_DIR}/override.conf"
PNPM_CMD=()
CREATED_ROOT_ENV=0
NON_INTERACTIVE=0
HYTALE_SERVER_PATH=""
HYTALE_ROOT_PATH=""
CANDIDATE_HYTALE_SERVER_PATHS=(
  "/opt/hytale/Server"
  "/srv/hytale/Server"
  "/home/hytale/Server"
  "/var/games/hytale/Server"
)

read_env_value() {
  local file="$1"
  local key="$2"

  if [ ! -f "$file" ]; then
    return 1
  fi

  awk -F= -v key="$key" '$1 == key { print substr($0, index($0, "=") + 1); exit }' "$file"
}

set_env_var() {
  local file="$1"
  local key="$2"
  local value="$3"

  if grep -q "^${key}=" "$file"; then
    # Replace via awk + ENVIRON so the value passes through byte-for-byte.
    # Avoids sed delimiter/backslash escaping and awk -v backslash expansion —
    # both of which mangled values containing /, &, \, |, or $.
    local tmp
    tmp="$(mktemp "${file}.XXXXXX")"
    VAR_VALUE="$value" awk -v key="$key" '
      BEGIN { replaced = 0; prefix = key "=" }
      {
        if (!replaced && index($0, prefix) == 1) {
          print prefix ENVIRON["VAR_VALUE"]
          replaced = 1
        } else {
          print
        }
      }
    ' "$file" > "$tmp"
    mv "$tmp" "$file"
  else
    printf '\n%s=%s\n' "$key" "$value" >> "$file"
  fi
}

ensure_env_var_if_missing() {
  local file="$1"
  local key="$2"
  local value="$3"
  local current_value

  current_value="$(read_env_value "$file" "$key" || true)"
  if [ -z "$current_value" ]; then
    set_env_var "$file" "$key" "$value"
  fi
}

require_env_var() {
  local file="$1"
  local key="$2"
  local value

  value="$(read_env_value "$file" "$key" || true)"
  if [ -z "$value" ]; then
    log_error "Required value ${key} is blank in ${file}"
    exit 1
  fi
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

remove_legacy_helper_socket_if_safe() {
  if [ "$LEGACY_HELPER_SOCKET_PATH" = "$STABLE_HELPER_SOCKET_PATH" ]; then
    return 0
  fi

  if [ -S "$LEGACY_HELPER_SOCKET_PATH" ] && [ -S "$STABLE_HELPER_SOCKET_PATH" ]; then
    rm -f "$LEGACY_HELPER_SOCKET_PATH"
    log_ok "Removed stale legacy helper socket at $LEGACY_HELPER_SOCKET_PATH"
  fi
}

prompt_value() {
  local prompt_label="$1"
  local current_value="$2"
  local input_value

  printf '%s [%s]: ' "$prompt_label" "$current_value"
  read -r input_value
  if [ -n "$input_value" ]; then
    printf '%s' "$input_value"
  else
    printf '%s' "$current_value"
  fi
}

prompt_port_value() {
  local prompt_label="$1"
  local current_value="$2"
  local candidate

  while true; do
    candidate="$(prompt_value "$prompt_label" "$current_value")"
    if [[ "$candidate" =~ ^[0-9]+$ ]] && [ "$candidate" -ge 1 ] && [ "$candidate" -le 65535 ]; then
      printf '%s' "$candidate"
      return 0
    fi
    log_warn "${prompt_label} must be a number between 1 and 65535."
  done
}

prompt_for_initial_env_setup() {
  local response
  local web_port
  local api_port
  local postgres_port
  local cors_origin
  local ws_allowed_origins

  if [ "$CREATED_ROOT_ENV" -ne 1 ] || [ ! -t 0 ] || [ "$NON_INTERACTIVE" -eq 1 ]; then
    return 0
  fi

  printf '\nCustomize host ports or browser origins now? [y/N]: '
  read -r response
  case "${response:-N}" in
    [Yy]*)
      ;;
    *)
      return 0
      ;;
  esac

  web_port="$(prompt_port_value "WEB_HOST_PORT" "$(read_env_value "$PANEL_DIR/.env" WEB_HOST_PORT || printf '3000')")"
  api_port="$(prompt_port_value "API_HOST_PORT" "$(read_env_value "$PANEL_DIR/.env" API_HOST_PORT || printf '4000')")"
  postgres_port="$(prompt_port_value "POSTGRES_HOST_PORT" "$(read_env_value "$PANEL_DIR/.env" POSTGRES_HOST_PORT || printf '5432')")"
  cors_origin="$(prompt_value "CORS_ORIGIN" "$(read_env_value "$PANEL_DIR/.env" CORS_ORIGIN || printf 'https://panel.yourdomain.com')")"
  ws_allowed_origins="$(prompt_value "WS_ALLOWED_ORIGINS" "$(read_env_value "$PANEL_DIR/.env" WS_ALLOWED_ORIGINS || printf '%s' "$cors_origin")")"

  set_env_var "$PANEL_DIR/.env" WEB_HOST_PORT "$web_port"
  set_env_var "$PANEL_DIR/.env" API_HOST_PORT "$api_port"
  set_env_var "$PANEL_DIR/.env" POSTGRES_HOST_PORT "$postgres_port"
  set_env_var "$PANEL_DIR/.env" CORS_ORIGIN "$cors_origin"
  set_env_var "$PANEL_DIR/.env" WS_ALLOWED_ORIGINS "$ws_allowed_origins"
}

wait_for_http() {
  local url="$1"
  local description="$2"
  local attempts="${3:-30}"

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

seed_admin_user() {
  local admin_username="$1"
  local admin_password="$2"
  local database_url="$3"

  log_info "Creating or updating the first admin user..."
  DATABASE_URL="$database_url" \
    ADMIN_USERNAME="$admin_username" \
    ADMIN_PASSWORD="$admin_password" \
    "${PNPM_CMD[@]}" --filter @hytale-panel/api seed
  log_ok "Admin seeding command completed"
}

prompt_for_admin_seed() {
  local database_url="$1"
  local response
  local admin_username
  local admin_password
  local confirm_password

  if [ ! -t 0 ] || [ "$NON_INTERACTIVE" -eq 1 ]; then
    log_warn "Skipping optional first-admin prompt (non-interactive)"
    return 0
  fi

  printf '\nCreate the first admin user now? [Y/n]: '
  read -r response
  case "${response:-Y}" in
    [Nn]*)
      log_warn "Skipping admin creation. You can run the seed command later from the summary below."
      return 0
      ;;
  esac

  while true; do
    printf 'Admin username: '
    read -r admin_username
    if [ -n "$admin_username" ]; then
      break
    fi
    log_warn "Username cannot be blank."
  done

  while true; do
    printf 'Admin password: '
    read -r -s admin_password
    printf '\nConfirm admin password: '
    read -r -s confirm_password
    printf '\n'

    if [ -z "$admin_password" ]; then
      log_warn "Password cannot be blank."
      continue
    fi

    if [ "$admin_password" != "$confirm_password" ]; then
      log_warn "Passwords did not match. Please try again."
      continue
    fi

    break
  done

  seed_admin_user "$admin_username" "$admin_password" "$database_url"
}

determine_panel_socket_gid() {
  local configured_gid

  configured_gid="$(read_env_value "$PANEL_DIR/.env" PANEL_SOCKET_GID || true)"
  if [ -z "$configured_gid" ]; then
    configured_gid="$DEFAULT_PANEL_SOCKET_GID"
  fi

  if ! [[ "$configured_gid" =~ ^[0-9]+$ ]]; then
    log_error "PANEL_SOCKET_GID must be numeric. Found: $configured_gid"
    exit 1
  fi

  PANEL_SOCKET_GID="$configured_gid"
}

ensure_panel_socket_group() {
  local existing_gid
  local gid_owner

  existing_gid="$(getent group "$PANEL_SOCKET_GROUP" | cut -d: -f3 || true)"
  if [ -n "$existing_gid" ]; then
    if [ "$existing_gid" != "$PANEL_SOCKET_GID" ]; then
      log_error "Group $PANEL_SOCKET_GROUP already exists with GID $existing_gid, expected $PANEL_SOCKET_GID"
      log_error "Update PANEL_SOCKET_GID in .env or reconcile the existing host group before continuing."
      exit 1
    fi
    log_ok "Group $PANEL_SOCKET_GROUP already exists with GID $PANEL_SOCKET_GID"
    return
  fi

  gid_owner="$(getent group "$PANEL_SOCKET_GID" | cut -d: -f1 || true)"
  if [ -n "$gid_owner" ]; then
    log_error "GID $PANEL_SOCKET_GID is already owned by group $gid_owner on this host."
    log_error "Choose a different PANEL_SOCKET_GID in .env before running install.sh."
    exit 1
  fi

  groupadd -g "$PANEL_SOCKET_GID" "$PANEL_SOCKET_GROUP"
  log_ok "Created group: $PANEL_SOCKET_GROUP (GID $PANEL_SOCKET_GID)"
}

deploy_helper_runtime() {
  local staging_dir="$1"
  local deploy_dir="/opt/hytale-panel/helper"

  rm -rf "$staging_dir"
  mkdir -p "$staging_dir"

  "${PNPM_CMD[@]}" --filter @hytale-panel/helper --prod deploy "$staging_dir"
  rm -rf "$staging_dir/node_modules/.pnpm/node_modules/@hytale-panel/helper"

  rm -rf "$deploy_dir/dist" "$deploy_dir/node_modules" "$deploy_dir/package.json"
  cp -R "$staging_dir/dist" "$deploy_dir/"
  cp -R "$staging_dir/node_modules" "$deploy_dir/"
  cp "$staging_dir/package.json" "$deploy_dir/"
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      -y|--yes|--non-interactive)
        NON_INTERACTIVE=1
        shift
        ;;
      -h|--help)
        cat <<'USAGE'
Usage: sudo ./install.sh [-y|--yes|--non-interactive]

  -y, --yes, --non-interactive
      Skip interactive prompts (preflight confirmation, env customization,
      admin seeding, Hytale world fallback). Missing detection defaults to
      /opt/hytale/Server.
  -h, --help
      Show this help and exit.
USAGE
        exit 0
        ;;
      *)
        log_warn "Unknown argument: $1 (ignored)"
        shift
        ;;
    esac
  done

  # Update-panel.sh and other automation call install.sh with SKIP_* env vars.
  # Treat that as non-interactive so we don't block on prompts inside CI.
  if [ "${SKIP_PANEL_BRINGUP:-0}" = "1" ] || [ "${SKIP_HELPER_BUILD:-0}" = "1" ] || [ "${SKIP_SYSTEM_DEPS:-0}" = "1" ]; then
    NON_INTERACTIVE=1
  fi
}

preflight_summary() {
  local response

  cat <<SUMMARY

Preflight summary — this script will:
  [1/9]  Install system dependencies (tmux, docker, node 20, pnpm)
  [2/9]  Create the hytale user + hytale-panel group (GID ${PANEL_SOCKET_GID})
  [3/9]  Detect or choose the Hytale server directory
  [4/9]  Create /opt/hytale, /opt/hytale-backups, /opt/hytale-panel with correct owners
  [5/9]  Install systemd units (hytale-helper.service, hytale-tmux.service)
  [6/9]  Retire legacy helper sudoers and override drop-ins
  [7/9]  Generate SESSION_SECRET, CSRF_SECRET, HELPER_HMAC_SECRET, DB_PASSWORD in .env
  [8/9]  Build and deploy the helper, reload systemd, bring up panel containers, run migrations
  [9/9]  Run scripts/doctor.sh and fail fast if anything looks wrong

SUMMARY

  if [ "$NON_INTERACTIVE" -eq 1 ] || [ ! -t 0 ]; then
    log_info "Non-interactive mode — proceeding without confirmation"
    return 0
  fi

  printf 'Press Enter to continue, or Ctrl-C to abort: '
  read -r response
}

detect_hytale_world() {
  local found=()
  local path
  local candidate
  local response
  local choice
  local i
  local input_path

  for path in "${CANDIDATE_HYTALE_SERVER_PATHS[@]}"; do
    if [ -d "$path" ] && { [ -f "$path/HytaleServer.jar" ] || [ -f "$path/server.jar" ]; }; then
      found+=("$path")
    fi
  done

  if [ "${#found[@]}" -eq 1 ]; then
    candidate="${found[0]}"
    log_ok "Detected Hytale server directory: $candidate"
    if [ "$NON_INTERACTIVE" -eq 1 ] || [ ! -t 0 ]; then
      HYTALE_SERVER_PATH="$candidate"
    else
      printf 'Use this directory? [Y/n]: '
      read -r response
      case "${response:-Y}" in
        [Nn]*) HYTALE_SERVER_PATH="" ;;
        *)     HYTALE_SERVER_PATH="$candidate" ;;
      esac
    fi
  elif [ "${#found[@]}" -gt 1 ]; then
    log_info "Multiple Hytale server directories detected:"
    i=1
    for path in "${found[@]}"; do
      printf '  %d) %s\n' "$i" "$path"
      i=$((i + 1))
    done
    if [ "$NON_INTERACTIVE" -eq 1 ] || [ ! -t 0 ]; then
      HYTALE_SERVER_PATH="${found[0]}"
      log_info "Non-interactive mode — selecting ${HYTALE_SERVER_PATH}"
    else
      while true; do
        printf 'Select a directory [1-%d]: ' "${#found[@]}"
        read -r choice
        if [[ "$choice" =~ ^[0-9]+$ ]] && [ "$choice" -ge 1 ] && [ "$choice" -le "${#found[@]}" ]; then
          HYTALE_SERVER_PATH="${found[$((choice - 1))]}"
          break
        fi
        log_warn "Enter a number between 1 and ${#found[@]}."
      done
    fi
  fi

  if [ -z "$HYTALE_SERVER_PATH" ]; then
    if [ "$NON_INTERACTIVE" -eq 1 ] || [ ! -t 0 ]; then
      HYTALE_SERVER_PATH="/opt/hytale/Server"
      log_warn "No Hytale server found — defaulting to ${HYTALE_SERVER_PATH} (install game files there later)"
    else
      log_warn "No Hytale server directory detected at any of:"
      for path in "${CANDIDATE_HYTALE_SERVER_PATHS[@]}"; do
        printf '    %s\n' "$path"
      done
      printf 'Enter a path now (or press Enter to default to /opt/hytale/Server): '
      read -r input_path
      HYTALE_SERVER_PATH="${input_path:-/opt/hytale/Server}"
    fi
  fi

  HYTALE_ROOT_PATH="$(dirname "$HYTALE_SERVER_PATH")"
  log_ok "Using HYTALE_ROOT=$HYTALE_ROOT_PATH, Server dir=$HYTALE_SERVER_PATH"

  if [ "$HYTALE_SERVER_PATH" != "/opt/hytale/Server" ]; then
    log_warn "Non-default Hytale path selected — hytale-tmux.service still references /opt/hytale."
    log_warn "Edit systemd/hytale-tmux.service and bind-mount or symlink $HYTALE_SERVER_PATH if the tmux game server needs those game files."
  fi
}

parse_args "$@"

echo ""
echo "============================================"
echo "  Hytale Panel — Installation Script"
echo "============================================"
echo ""

# ─── Pre-flight Checks ─────────────────────────────────────
if [ "$EUID" -ne 0 ]; then
  log_error "Please run as root: sudo ./install.sh"
  exit 1
fi

if ! grep -q "Ubuntu" /etc/os-release 2>/dev/null; then
  log_warn "This script is designed for Ubuntu 22.04+. Proceed with caution on other distros."
fi

# Check minimum Ubuntu version
if command -v lsb_release &>/dev/null; then
  UBUNTU_VERSION=$(lsb_release -rs 2>/dev/null || echo "0")
  if (( $(echo "$UBUNTU_VERSION < 22.04" | bc -l 2>/dev/null || echo 0) )); then
    log_warn "Ubuntu 22.04+ recommended. Detected: $UBUNTU_VERSION"
  fi
fi

determine_panel_socket_gid

preflight_summary

# ─── Step 1: System Dependencies ───────────────────────────
if [ "${SKIP_SYSTEM_DEPS:-0}" = "1" ]; then
  log_info "[1/9] Skipping system dependency installation (SKIP_SYSTEM_DEPS=1)"
else
  log_info "[1/9] Installing system dependencies..."
  apt-get update -qq
  apt-get install -y -qq tmux curl openssl bc

  # Install Docker if not present
  if ! command -v docker &>/dev/null; then
    log_info "Installing Docker..."
    apt-get install -y -qq docker.io
    systemctl enable --now docker
    log_ok "Docker installed"
  else
    log_ok "Docker already installed"
  fi

  # Install Docker Compose v2 plugin if not present
  if ! docker compose version &>/dev/null; then
    log_info "Installing Docker Compose v2..."
    apt-get install -y -qq docker-compose-v2 2>/dev/null || {
      # Fallback: install from GitHub
      COMPOSE_VERSION=$(curl -s https://api.github.com/repos/docker/compose/releases/latest | grep tag_name | cut -d '"' -f 4)
      curl -SL "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-$(uname -m)" -o /usr/local/bin/docker-compose
      chmod +x /usr/local/bin/docker-compose
    }
    log_ok "Docker Compose v2 installed"
  else
    log_ok "Docker Compose v2 already installed"
  fi

  # Install Node.js 20 LTS if not present (needed for helper service)
  if ! command -v node &>/dev/null || [[ $(node -v | cut -d. -f1 | tr -d 'v') -lt 20 ]]; then
    log_info "Installing Node.js 20 LTS..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y -qq nodejs
    log_ok "Node.js $(node -v) installed"
  else
    log_ok "Node.js $(node -v) already installed"
  fi

  # Install pnpm via corepack (required — this project uses pnpm workspaces)
  if ! command -v pnpm &>/dev/null; then
    log_info "Installing pnpm via corepack..."
    if corepack enable && corepack prepare pnpm@9 --activate; then
      :
    else
      log_warn "corepack prepare pnpm@9 failed; falling back to npm install -g pnpm@9.15.4"
      npm install -g pnpm@9.15.4
    fi
    log_ok "pnpm $(pnpm -v) installed"
  else
    log_ok "pnpm $(pnpm -v) already installed"
  fi
fi

if command -v pnpm &>/dev/null; then
  PNPM_CMD=(pnpm)
else
  PNPM_CMD=(npx -y pnpm@9.15.4)
fi

# ─── Step 2: System Users ──────────────────────────────────
log_info "[2/9] Creating system users and groups..."

ensure_panel_socket_group

if ! id "hytale" &>/dev/null; then
  useradd -r -m -d /opt/hytale -s /bin/bash hytale
  log_ok "Created user: hytale"
else
  log_ok "User hytale already exists"
fi

if ! id "hytale-helper" &>/dev/null; then
  useradd -r -s /usr/sbin/nologin -g "$PANEL_SOCKET_GROUP" -G hytale hytale-helper
  log_ok "Created user: hytale-helper"
else
  log_ok "User hytale-helper already exists"
fi

# Keep the legacy hytale-helper account aligned for older deployments that still
# have files owned by it, even though the shipped helper service now runs as root.
usermod -g "$PANEL_SOCKET_GROUP" -aG hytale hytale-helper 2>/dev/null || true

# ─── Step 3: Hytale World Auto-Detection ───────────────────
log_info "[3/9] Detecting or selecting the Hytale server directory..."
detect_hytale_world

# ─── Step 4: Directories ───────────────────────────────────
log_info "[4/9] Setting up directories..."

mkdir -p /opt/hytale
mkdir -p /opt/hytale/run
mkdir -p /opt/hytale/tmp
mkdir -p /opt/hytale-backups
mkdir -p /opt/hytale-panel
mkdir -p /opt/hytale-panel/helper
mkdir -p "$HELPER_RUNTIME_DIR"

if [ "$HYTALE_SERVER_PATH" = "/opt/hytale/Server" ]; then
  mkdir -p /opt/hytale/Server
fi

# Ownership and permissions
chown hytale:hytale /opt/hytale
if [ -d "$HYTALE_SERVER_PATH" ]; then
  chown -R hytale:hytale "$HYTALE_SERVER_PATH" 2>/dev/null || \
    log_warn "Could not chown $HYTALE_SERVER_PATH — ensure the hytale user can read/write game files"
fi
chown hytale:hytale /opt/hytale/run
chmod 770 /opt/hytale/run
chown hytale:hytale /opt/hytale/tmp
chmod 770 /opt/hytale/tmp
chown hytale:hytale /opt/hytale-backups
chmod 770 /opt/hytale-backups                    # hytale + helper supplementary group access
chown -R root:"$PANEL_SOCKET_GROUP" /opt/hytale-panel/helper
chmod 750 /opt/hytale-panel/helper
chown root:"$PANEL_SOCKET_GROUP" "$HELPER_RUNTIME_DIR"
chmod 770 "$HELPER_RUNTIME_DIR"

log_ok "Directories created with correct permissions"

# ─── Step 5: Systemd Services ──────────────────────────────
log_info "[5/9] Installing systemd services..."

cp "$PANEL_DIR/systemd/hytale-tmux.service" /etc/systemd/system/
cp "$PANEL_DIR/systemd/hytale-helper.service" /etc/systemd/system/
retire_legacy_helper_override

log_ok "Systemd units installed"

# ─── Step 6: Retire Legacy Helper Overrides ────────────────
log_info "[6/9] Retiring legacy helper overrides..."

if [ -f /etc/sudoers.d/hytale-helper ]; then
  rm -f /etc/sudoers.d/hytale-helper
  log_ok "Removed legacy /etc/sudoers.d/hytale-helper (helper now runs as root with a local-only sandbox)"
else
  log_ok "No legacy helper sudoers file present"
fi

# ─── Step 7: Generate Secrets ──────────────────────────────
log_info "[7/9] Generating cryptographic secrets..."

if [ ! -f "$PANEL_DIR/.env" ]; then
  cp "$PANEL_DIR/.env.example" "$PANEL_DIR/.env"
  CREATED_ROOT_ENV=1
  log_ok "Created .env from .env.example"
fi

if [ -z "$(read_env_value "$PANEL_DIR/.env" SESSION_SECRET || true)" ]; then
  set_env_var "$PANEL_DIR/.env" SESSION_SECRET "$(openssl rand -hex 32)"
fi

if [ -z "$(read_env_value "$PANEL_DIR/.env" CSRF_SECRET || true)" ]; then
  set_env_var "$PANEL_DIR/.env" CSRF_SECRET "$(openssl rand -hex 32)"
fi

if [ -z "$(read_env_value "$PANEL_DIR/.env" HELPER_HMAC_SECRET || true)" ]; then
  set_env_var "$PANEL_DIR/.env" HELPER_HMAC_SECRET "$(openssl rand -hex 32)"
fi

if [ -z "$(read_env_value "$PANEL_DIR/.env" DB_PASSWORD || true)" ]; then
  set_env_var "$PANEL_DIR/.env" DB_PASSWORD "$(openssl rand -hex 16)"
fi

set_env_var "$PANEL_DIR/.env" PANEL_SOCKET_GID "$PANEL_SOCKET_GID"

require_env_var "$PANEL_DIR/.env" DB_PASSWORD
require_env_var "$PANEL_DIR/.env" SESSION_SECRET
require_env_var "$PANEL_DIR/.env" CSRF_SECRET
require_env_var "$PANEL_DIR/.env" HELPER_HMAC_SECRET
require_env_var "$PANEL_DIR/.env" PANEL_SOCKET_GID

prompt_for_initial_env_setup

if [ "$(read_env_value "$PANEL_DIR/.env" PANEL_SOCKET_GID)" != "$PANEL_SOCKET_GID" ]; then
  log_error "PANEL_SOCKET_GID in .env does not match the installed host group GID."
  exit 1
fi

log_ok ".env contains non-empty DB password and required secrets"
echo ""
log_warn "IMPORTANT: Edit .env to set CORS_ORIGIN and WS_ALLOWED_ORIGINS to your domain"
echo "    Example: CORS_ORIGIN=https://panel.yourdomain.com"
echo ""

# ─── Step 8: Helper Service Setup & Panel Bring-Up ─────────
log_info "[8/9] Deploying helper service and bringing up the panel..."

# Extract HMAC secret from .env
HMAC_SECRET="$(read_env_value "$PANEL_DIR/.env" HELPER_HMAC_SECRET)"

# Create helper .env if not exists
if [ ! -f "$HELPER_ENV_FILE" ]; then
  cat > "$HELPER_ENV_FILE" << HELPEREOF
# Hytale Panel Helper Service Configuration
# This file is read by the helper service on startup.

# Host Unix socket path (the API container sees this via a bind mount at /run/hytale-helper)
HELPER_SOCKET_PATH=$STABLE_HELPER_SOCKET_PATH

# HMAC shared secret (must match API's HELPER_HMAC_SECRET)
HELPER_HMAC_SECRET=$HMAC_SECRET

# Hytale server paths
HYTALE_ROOT=$HYTALE_ROOT_PATH
BACKUP_PATH=/opt/hytale-backups
HYTALE_SERVICE_NAME=hytale-tmux.service
TMUX_SESSION=hytale
TMUX_SOCKET_PATH=/opt/hytale/run/hytale.tmux.sock

# Game server file paths
WHITELIST_PATH=$HYTALE_SERVER_PATH/whitelist.json
BANS_PATH=$HYTALE_SERVER_PATH/bans.json
WORLDS_PATH=$HYTALE_SERVER_PATH/worlds
HELPEREOF

  chown root:"$PANEL_SOCKET_GROUP" "$HELPER_ENV_FILE"
  chmod 640 "$HELPER_ENV_FILE"
  log_ok "Created helper .env"
else
  log_ok "Helper .env already exists"
fi

CURRENT_HELPER_SOCKET_PATH="$(read_env_value "$HELPER_ENV_FILE" HELPER_SOCKET_PATH || true)"
if [ -n "$CURRENT_HELPER_SOCKET_PATH" ] && [ "$CURRENT_HELPER_SOCKET_PATH" != "$STABLE_HELPER_SOCKET_PATH" ]; then
  log_info "Migrating helper HELPER_SOCKET_PATH from $CURRENT_HELPER_SOCKET_PATH to $STABLE_HELPER_SOCKET_PATH"
fi

set_env_var "$HELPER_ENV_FILE" HELPER_SOCKET_PATH "$STABLE_HELPER_SOCKET_PATH"
ensure_env_var_if_missing "$HELPER_ENV_FILE" HELPER_HMAC_SECRET "$HMAC_SECRET"
ensure_env_var_if_missing "$HELPER_ENV_FILE" HYTALE_ROOT "$HYTALE_ROOT_PATH"
ensure_env_var_if_missing "$HELPER_ENV_FILE" BACKUP_PATH /opt/hytale-backups
ensure_env_var_if_missing "$HELPER_ENV_FILE" HYTALE_SERVICE_NAME hytale-tmux.service
ensure_env_var_if_missing "$HELPER_ENV_FILE" TMUX_SESSION hytale
ensure_env_var_if_missing "$HELPER_ENV_FILE" TMUX_SOCKET_PATH /opt/hytale/run/hytale.tmux.sock
ensure_env_var_if_missing "$HELPER_ENV_FILE" WHITELIST_PATH "$HYTALE_SERVER_PATH/whitelist.json"
ensure_env_var_if_missing "$HELPER_ENV_FILE" BANS_PATH "$HYTALE_SERVER_PATH/bans.json"
ensure_env_var_if_missing "$HELPER_ENV_FILE" WORLDS_PATH "$HYTALE_SERVER_PATH/worlds"
chown root:"$PANEL_SOCKET_GROUP" "$HELPER_ENV_FILE"
chmod 640 "$HELPER_ENV_FILE"

# Build and deploy helper service if source is available
if [ "${SKIP_HELPER_BUILD:-0}" = "1" ]; then
  log_info "Skipping helper build/deploy (SKIP_HELPER_BUILD=1)"
elif [ -d "$PANEL_DIR/packages/helper" ]; then
  log_info "Building helper service..."

  cd "$PANEL_DIR"
  HELPER_STAGING_DIR="$(mktemp -d /tmp/hytale-helper-deploy.XXXXXX)"
  trap 'rm -rf "$HELPER_STAGING_DIR"' EXIT

  # Install all workspace dependencies
  "${PNPM_CMD[@]}" install --frozen-lockfile

  # Build shared first, then helper
  "${PNPM_CMD[@]}" run build:shared
  "${PNPM_CMD[@]}" run build:helper

  # Deploy a self-contained helper runtime that matches the systemd ExecStart path.
  deploy_helper_runtime "$HELPER_STAGING_DIR"

  chown -R root:"$PANEL_SOCKET_GROUP" /opt/hytale-panel/helper/
  log_ok "Helper service built and deployed"

  cd "$PANEL_DIR"
fi

# Reload systemd and bring up the panel stack (continuation of [8/9])
log_info "Reloading systemd and bringing up the panel stack..."
systemctl daemon-reload

if systemctl list-unit-files hytale.service >/dev/null 2>&1; then
  if systemctl is-enabled --quiet hytale.service 2>/dev/null || systemctl is-active --quiet hytale.service 2>/dev/null; then
    log_info "Disabling legacy hytale.service to prevent duplicate launches..."
    systemctl disable --now hytale.service || true
    log_ok "Legacy hytale.service disabled"
  fi
fi

log_info "Enabling and restarting helper service..."
systemctl enable hytale-helper.service >/dev/null 2>&1 || true
systemctl restart hytale-helper.service

if systemctl is-active --quiet hytale-helper.service; then
  log_ok "Helper service is running with the shipped unit"
else
  log_error "Helper service failed to start"
  echo "Check logs: journalctl -u hytale-helper.service --no-pager -n 50"
  exit 1
fi

wait_for_socket "$STABLE_HELPER_SOCKET_PATH" "Helper is listening on the stable host socket path" 30

remove_legacy_helper_socket_if_safe

API_HOST_PORT="${API_HOST_PORT:-$(read_env_value "$PANEL_DIR/.env" API_HOST_PORT || true)}"
API_HOST_PORT="${API_HOST_PORT:-4000}"
WEB_HOST_PORT="${WEB_HOST_PORT:-$(read_env_value "$PANEL_DIR/.env" WEB_HOST_PORT || true)}"
WEB_HOST_PORT="${WEB_HOST_PORT:-3000}"
POSTGRES_HOST_PORT="${POSTGRES_HOST_PORT:-$(read_env_value "$PANEL_DIR/.env" POSTGRES_HOST_PORT || true)}"
POSTGRES_HOST_PORT="${POSTGRES_HOST_PORT:-5432}"
if [ "${SKIP_PANEL_BRINGUP:-0}" = "1" ]; then
  log_info "Skipping panel container bring-up and migrations (SKIP_PANEL_BRINGUP=1)"
else
  DB_PASSWORD_VALUE="$(read_env_value "$PANEL_DIR/.env" DB_PASSWORD)"
  DATABASE_URL_VALUE="postgresql://hytale_panel:${DB_PASSWORD_VALUE}@127.0.0.1:${POSTGRES_HOST_PORT}/hytale_panel"

  log_info "Starting panel containers..."
  cd "$PANEL_DIR"
  docker compose up -d --build postgres api web

  wait_for_http "http://127.0.0.1:${API_HOST_PORT}/api/health" "API health check passed on 127.0.0.1:${API_HOST_PORT}" 60
  wait_for_http "http://127.0.0.1:${WEB_HOST_PORT}/api/health" "Web proxy health check passed on 127.0.0.1:${WEB_HOST_PORT}" 60

  log_info "Running database migrations..."
  docker compose exec -T api node dist/db/migrate.js
  log_ok "Database migrations completed"

  if [ -n "${ADMIN_USERNAME:-}" ] && [ -n "${ADMIN_PASSWORD:-}" ]; then
    seed_admin_user "${ADMIN_USERNAME}" "${ADMIN_PASSWORD}" "$DATABASE_URL_VALUE"
  elif [ -n "${ADMIN_USERNAME:-}" ] || [ -n "${ADMIN_PASSWORD:-}" ]; then
    log_warn "ADMIN_USERNAME and ADMIN_PASSWORD must both be set to seed automatically; skipping admin creation"
  else
    prompt_for_admin_seed "$DATABASE_URL_VALUE"
  fi
fi

log_ok "Systemd reloaded"

# ─── Step 9: Doctor Verification ───────────────────────────
if [ "${SKIP_PANEL_BRINGUP:-0}" = "1" ]; then
  log_info "[9/9] Skipping doctor verification because SKIP_PANEL_BRINGUP=1"
else
  log_info "[9/9] Running scripts/doctor.sh to verify the installation..."
  if bash "$PANEL_DIR/scripts/doctor.sh"; then
    log_ok "Doctor verification passed"
  else
    echo ""
    echo "============================================"
    log_error "Doctor verification FAILED"
    echo "============================================"
    echo ""
    echo "The install finished but doctor found problems."
    echo "Review the output above, then re-run:"
    echo "  bash scripts/doctor.sh          # re-check"
    echo "  bash scripts/doctor.sh --fix    # attempt safe auto-fixes"
    echo ""
    exit 1
  fi
fi

# ─── Summary ───────────────────────────────────────────────
echo ""
echo "============================================"
echo "  Installation Complete!"
echo "============================================"
echo ""
echo "What is ready now:"
echo "  - hytale-helper.service installed with the shipped root helper model"
echo "  - Legacy hytale.service retired automatically if it existed"
if [ "${SKIP_PANEL_BRINGUP:-0}" = "1" ]; then
  echo "  - Panel container bring-up was skipped on purpose"
else
  echo "  - postgres/api/web containers built and started"
  echo "  - Database migrations completed"
fi
echo ""
echo "Operator commands:"
echo "  - Update:  bash deploy/update-panel.sh"
echo "  - Repair:  bash scripts/repair-panel.sh"
echo "  - Health:  bash scripts/doctor.sh"
echo "  - Smoke:   bash scripts/smoke-test.sh"
echo ""
echo "Next steps:"
echo "  1. Install the Hytale server files under ${HYTALE_SERVER_PATH} and create ${HYTALE_ROOT_PATH}/start.sh"
echo "  2. Start the tmux-managed game server when ready:"
echo "     sudo systemctl enable hytale-tmux.service"
echo "     sudo systemctl restart hytale-tmux.service"
echo "  3. Edit .env and set your browser origins for private testing or your real domain:"
echo "     nano .env"
echo "     # After changing host ports or origins later, rerun: bash deploy/update-panel.sh"
echo "  4. If you skipped admin creation, create the first admin user:"
echo "     DB_PASSWORD=\$(grep '^DB_PASSWORD=' .env | cut -d= -f2-)"
echo "     POSTGRES_HOST_PORT=\${POSTGRES_HOST_PORT:-5432}"
echo "     DATABASE_URL=\"postgresql://hytale_panel:\${DB_PASSWORD}@127.0.0.1:\${POSTGRES_HOST_PORT}/hytale_panel\" pnpm --filter @hytale-panel/api seed"
echo "  5. For private first-run access, use an SSH tunnel to WEB_HOST_PORT and complete admin TOTP enrollment"
echo "  6. Set up your reverse proxy when private testing is complete (see docs/reverse-proxy.md)"
echo ""
echo "Security reminders:"
echo "  - API binds to 127.0.0.1:4000 only — never exposed directly"
echo "  - Always use TLS via reverse proxy"
echo "  - Review .env settings before production use"
echo "  - Helper runs as root with a local-only systemd sandbox and HMAC-authenticated Unix socket"
echo "  - API container joins helper socket GID \$PANEL_SOCKET_GID to reach /run/hytale-helper/hytale-helper.sock"
echo "  - Host helper socket path is $HELPER_RUNTIME_DIR/hytale-helper.sock"
echo ""
