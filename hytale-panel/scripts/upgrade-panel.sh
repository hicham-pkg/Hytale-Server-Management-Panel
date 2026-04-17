#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "[INFO] scripts/upgrade-panel.sh now delegates to ./deploy/update-panel.sh"
exec bash ./deploy/update-panel.sh
