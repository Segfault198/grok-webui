#!/usr/bin/env bash
# Daily leaf belief maintain + calibrate (P1+P2). Installed on oc.
# Exit non-zero if calibrate hard-gates (G3). Always writes state/last-report.*.
set -euo pipefail

ROOT="${BELIEFS_INSTALL_ROOT:-$HOME/.local/share/hzr-skills/leaf-wiki}"
SCRIPTS="$ROOT/scripts"
STATE="$ROOT/state"
REGISTRY="${BELIEFS_REGISTRY:-$ROOT/leaf-projects.yaml}"
HOME_DIR="${HOME:-/home/steve}"
PY="${BELIEFS_PYTHON:-/usr/bin/python3}"

mkdir -p "$STATE"
cd "$HOME_DIR"

echo "[beliefs-daily] maintain $(date -u +%Y-%m-%dT%H:%MZ)"
"$PY" "$SCRIPTS/maintain-beliefs.py" --scan-oc-shared --home "$HOME_DIR" | tee "$STATE/last-maintain.log"

echo "[beliefs-daily] calibrate $(date -u +%Y-%m-%dT%H:%MZ)"
set +e
"$PY" "$SCRIPTS/calibrate-beliefs.py" \
  --scan-oc-shared \
  --home "$HOME_DIR" \
  --registry "$REGISTRY" \
  --state-dir "$STATE" | tee "$STATE/last-calibrate.log"
rc=${PIPESTATUS[0]}
set -e

echo "[beliefs-daily] done rc=$rc"
exit "$rc"
