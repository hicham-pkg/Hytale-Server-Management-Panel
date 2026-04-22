#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [ ! -f .env ]; then
  echo "[ERROR] Missing .env in ${ROOT_DIR}. Run sudo ./install.sh first." >&2
  exit 1
fi

if command -v pnpm >/dev/null 2>&1; then
  PNPM_CMD=(pnpm)
else
  PNPM_CMD=(npx -y pnpm@9.15.4)
fi

docker_compose() {
  if docker info >/dev/null 2>&1; then
    docker compose "$@"
    return $?
  fi

  if command -v sudo >/dev/null 2>&1 && sudo docker info >/dev/null 2>&1; then
    sudo docker compose "$@"
    return $?
  fi

  echo "[ERROR] Docker is installed but not accessible for this user. Use a docker-group user or run this script with sudo-capable Docker access." >&2
  return 1
}

wait_for_http() {
  local url="$1"
  local description="$2"
  local attempts="${3:-60}"

  for _ in $(seq 1 "$attempts"); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      echo "[OK] ${description}"
      return 0
    fi
    sleep 1
  done

  echo "[ERROR] ${description}" >&2
  return 1
}

echo ""
echo "============================================"
echo "  Hytale Panel Update"
echo "============================================"
echo ""

echo "[1/9] Installing workspace dependencies..."
"${PNPM_CMD[@]}" install

echo ""
echo "[2/9] Building workspace..."
"${PNPM_CMD[@]}" build

echo ""
echo "[3/9] Refreshing installed units, env backfills, and directories..."
echo "      (install.sh will re-prompt for ports and browser origins — press"
echo "      Enter at each prompt to keep current values.)"
sudo env SKIP_SYSTEM_DEPS=1 SKIP_HELPER_BUILD=1 SKIP_PANEL_BRINGUP=1 ./install.sh

echo ""
echo "[4/9] Redeploying the helper and refreshing API socket wiring..."
sudo ./deploy/deploy-helper.sh

echo ""
echo "[5/9] Rebuilding and recreating panel containers..."
docker_compose up -d --build postgres api web

echo ""
echo "[6/9] Waiting for API and web health..."
API_HOST_PORT="${API_HOST_PORT:-$(grep -E '^API_HOST_PORT=' .env | tail -n 1 | cut -d= -f2- || true)}"
API_HOST_PORT="${API_HOST_PORT:-4000}"
WEB_HOST_PORT="${WEB_HOST_PORT:-$(grep -E '^WEB_HOST_PORT=' .env | tail -n 1 | cut -d= -f2- || true)}"
WEB_HOST_PORT="${WEB_HOST_PORT:-3000}"
wait_for_http "http://127.0.0.1:${API_HOST_PORT}/api/health" "API health is ready on 127.0.0.1:${API_HOST_PORT}" 60
wait_for_http "http://127.0.0.1:${WEB_HOST_PORT}/api/health" "Web proxy can reach /api/health on 127.0.0.1:${WEB_HOST_PORT}" 60

echo ""
echo "[7/9] Running database migrations..."
docker_compose exec -T api node dist/db/migrate.js

echo ""
echo "[8/9] Running repair flow..."
bash scripts/repair-panel.sh

echo ""
echo "[9/9] Final smoke test..."
bash scripts/smoke-test.sh

echo ""
echo "============================================"
echo "  Update Complete"
echo "============================================"
echo ""
echo "Post-update checks:"
echo "  Health:   bash scripts/doctor.sh"
echo "  Repair:   bash scripts/repair-panel.sh"
echo "  Rollback: bash deploy/rollback-panel.sh <git-ref>"
