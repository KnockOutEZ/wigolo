#!/bin/sh
# Run both SDK suites (drift tests lock the SDKs to the live /openapi.json contract).
# Run-if-present: exits 0 quietly when the SDK dirs are absent (pre-P3 checkouts).
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ -d "$ROOT/sdks/typescript" ]; then
  echo "== TypeScript SDK suite (type drift + runtime drift + integration) =="
  [ -d "$ROOT/sdks/typescript/node_modules" ] || npm --prefix "$ROOT/sdks/typescript" install --no-audit --no-fund
  npm --prefix "$ROOT/sdks/typescript" test
fi

if [ -d "$ROOT/sdks/python" ]; then
  echo "== Python SDK suite (signature drift + runtime drift + integration) =="
  PY="$ROOT/sdks/python/.venv/bin/python"
  [ -x "$PY" ] || { python3 -m venv "$ROOT/sdks/python/.venv" && "$ROOT/sdks/python/.venv/bin/pip" install -q pytest build; }
  "$PY" -m pytest "$ROOT/sdks/python/tests"
fi

echo "SDK suites: ALL PASSED"
