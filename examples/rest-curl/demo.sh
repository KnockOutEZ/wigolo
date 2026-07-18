#!/usr/bin/env bash
# wigolo over plain HTTP: start the daemon, hit it with curl, tear it down.
# Every wigolo tool is a POST /v1/{tool} endpoint with a JSON body; discovery
# and an OpenAPI document come free.
#
#   ./demo.sh                              # open mode on 127.0.0.1
#   WIGOLO_API_TOKEN=wigolo-demo-token ./demo.sh   # bearer-token mode
#
# Requires: node >= 20, curl, jq.
set -euo pipefail

WIGOLO="${WIGOLO:-npx wigolo}"
PORT="${PORT:-3477}"
BASE="http://127.0.0.1:${PORT}"

# When WIGOLO_API_TOKEN is set, the daemon (which inherits it) requires
# `Authorization: Bearer <token>` on /v1/* and /openapi.json — /health stays open.
wcurl() {
  if [[ -n "${WIGOLO_API_TOKEN:-}" ]]; then
    curl -s -H "Authorization: Bearer ${WIGOLO_API_TOKEN}" "$@"
  else
    curl -s "$@"
  fi
}

echo "starting wigolo daemon on :${PORT} ..."
$WIGOLO serve --port "${PORT}" >/dev/null 2>&1 &
DAEMON_PID=$!
trap 'echo; echo "stopping daemon (pid ${DAEMON_PID})"; kill "${DAEMON_PID}" 2>/dev/null || true; wait "${DAEMON_PID}" 2>/dev/null || true' EXIT

for _ in $(seq 1 60); do
  curl -sf "${BASE}/health" >/dev/null 2>&1 && break
  sleep 0.5
done

echo
echo "== GET /health (never needs a token) =="
curl -s "${BASE}/health" | jq .

echo
echo "== GET /v1/tools — discover the tool surface =="
wcurl "${BASE}/v1/tools" | jq -r 'map(.name) | join("  ")'

echo
echo "== POST /v1/search =="
wcurl -X POST "${BASE}/v1/search" \
  -H 'Content-Type: application/json' \
  -d '{"query": "typescript satisfies operator", "max_results": 3, "include_content": false}' \
  | jq '{results: [.results[] | {title, url}], total_time_ms}'

echo
echo "== GET /openapi.json — the whole API, machine-readable =="
wcurl "${BASE}/openapi.json" | jq '.info'

if [[ -n "${WIGOLO_API_TOKEN:-}" ]]; then
  echo
  echo "== token mode: the same call WITHOUT the header is refused =="
  curl -s -o /dev/null -w 'GET /v1/tools without token -> HTTP %{http_code}\n' "${BASE}/v1/tools"
fi
