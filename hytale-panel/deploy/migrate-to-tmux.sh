#!/bin/bash
# ============================================================
# Hytale Server — Migrate from systemd-only to systemd+tmux
# ============================================================
# This script migrates an existing hytale.service (pure systemd)
# to hytale-tmux.service (systemd + tmux wrapper) which enables
# live console interaction via the panel.
#
# What changes:
#   - Old: hytale.service runs the server directly (no stdin access)
#   - New: hytale-tmux.service wraps the server in a tmux session
#
# The game server itself is unchanged. Only the way systemd
# manages it is different.
#
# Usage: sudo ./deploy/migrate-to-tmux.sh
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

if [ "$EUID" -ne 0 ]; then
  log_error "Please run as root: sudo ./deploy/migrate-to-tmux.sh"
  exit 1
fi

echo ""
echo "============================================"
echo "  Hytale — tmux Migration Script"
echo "============================================"
echo ""

# ─── Pre-flight checks ─────────────────────────────────────
if ! command -v tmux &>/dev/null; then
  log_info "Installing tmux..."
  apt-get install -y -qq tmux
  log_ok "tmux installed"
fi

if ! id "hytale" &>/dev/null; then
  log_error "User 'hytale' does not exist. Run install.sh first."
  exit 1
fi

# ─── Check for existing service ────────────────────────────
OLD_SERVICE="hytale.service"
NEW_SERVICE="hytale-tmux.service"

if systemctl is-active --quiet "$NEW_SERVICE" 2>/dev/null; then
  log_ok "hytale-tmux.service is already active. Migration not needed."
  exit 0
fi

# ─── Check if start.sh exists ──────────────────────────────
if [ ! -f /opt/hytale/start.sh ]; then
  log_warn "/opt/hytale/start.sh not found."
  echo ""
  echo "Create a start script for your Hytale server. Example:"
  echo ""
  echo "  cat > /opt/hytale/start.sh << 'EOF'"
  echo "  #!/bin/bash"
  echo "  cd /opt/hytale"
  echo "  java -Xmx4G -Xms2G -jar /opt/hytale/HytaleServer.jar"
  echo "  EOF"
  echo "  chmod +x /opt/hytale/start.sh"
  echo "  chown hytale:hytale /opt/hytale/start.sh"
  echo ""
  read -p "Continue anyway? (y/N) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    exit 1
  fi
fi

# ─── Stop old service ──────────────────────────────────────
if systemctl is-active --quiet "$OLD_SERVICE" 2>/dev/null; then
  log_info "Stopping $OLD_SERVICE..."
  systemctl stop "$OLD_SERVICE"
  log_ok "Stopped $OLD_SERVICE"
fi

if systemctl is-enabled --quiet "$OLD_SERVICE" 2>/dev/null; then
  log_info "Disabling $OLD_SERVICE..."
  systemctl disable "$OLD_SERVICE"
  log_ok "Disabled $OLD_SERVICE"
fi

# ─── Install new service ───────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ -f "$SCRIPT_DIR/systemd/hytale-tmux.service" ]; then
  cp "$SCRIPT_DIR/systemd/hytale-tmux.service" /etc/systemd/system/
  log_ok "Installed hytale-tmux.service"
else
  log_error "Cannot find systemd/hytale-tmux.service. Run from the hytale-panel directory."
  exit 1
fi

systemctl daemon-reload

# ─── Enable and start ──────────────────────────────────────
systemctl enable "$NEW_SERVICE"
log_ok "Enabled $NEW_SERVICE"

read -p "Start the game server now? (Y/n) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Nn]$ ]]; then
  systemctl start "$NEW_SERVICE"
  sleep 2
  if systemctl is-active --quiet "$NEW_SERVICE"; then
    log_ok "Game server started in tmux session"
    echo ""
    echo "To attach to the console:"
    echo "  sudo -u hytale tmux attach -t hytale"
    echo "  (Detach with Ctrl+B, then D)"
  else
    log_error "Service failed to start. Check: journalctl -u $NEW_SERVICE"
  fi
fi

echo ""
echo "============================================"
echo "  Migration Complete!"
echo "============================================"
echo ""
echo "Old service ($OLD_SERVICE) has been disabled."
echo "New service ($NEW_SERVICE) is now managing the game server."
echo ""
echo "The panel can now send commands to the game server console."
echo ""
