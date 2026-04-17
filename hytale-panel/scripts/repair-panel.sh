#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo ""
echo "============================================"
echo "  Hytale Panel Repair"
echo "============================================"
echo ""

echo "[1/3] Running repair-aware doctor..."
bash scripts/doctor.sh --repair

echo ""
echo "[2/3] Rechecking panel wiring..."
bash scripts/smoke-test.sh

echo ""
echo "[3/3] Repair summary"
echo "  Helper unit checked"
echo "  Legacy hytale.service retired if needed"
echo "  API container refreshed if helper socket wiring was stale"
echo "  Runtime reconciled if tmux/systemd state drifted"
echo ""
