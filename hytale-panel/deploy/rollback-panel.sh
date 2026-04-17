#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [ $# -ne 1 ]; then
  echo "Usage: bash deploy/rollback-panel.sh <git-ref>" >&2
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  echo "[ERROR] git is required for rollback-panel.sh" >&2
  exit 1
fi

TARGET_REF="$1"

if ! git rev-parse --verify "${TARGET_REF}^{commit}" >/dev/null 2>&1; then
  echo "[ERROR] Could not resolve git ref: ${TARGET_REF}" >&2
  exit 1
fi

CURRENT_REF="$(git rev-parse --short HEAD)"
TARGET_COMMIT="$(git rev-parse --short "${TARGET_REF}^{commit}")"

echo ""
echo "============================================"
echo "  Hytale Panel Rollback"
echo "============================================"
echo ""
echo "[INFO] Current checkout: ${CURRENT_REF}"
echo "[INFO] Rolling back to:  ${TARGET_COMMIT}"
echo ""

git checkout "${TARGET_REF}"

echo "[INFO] Redeploying the panel from ${TARGET_COMMIT}..."
bash ./deploy/update-panel.sh

echo ""
echo "============================================"
echo "  Rollback Complete"
echo "============================================"
echo ""
echo "If this release changed the database schema incompatibly, restore your pre-upgrade database backup as documented in docs/upgrade.md."
