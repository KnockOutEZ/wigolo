#!/usr/bin/env bash
# shell + NDJSON: pipe commands into one wigolo process, get one JSON doc per
# line back on stdout (all human chatter goes to stderr), filter with jq,
# and gate on the exit code.
#
#   ./pipeline.sh                  # uses `npx wigolo`
#   WIGOLO="wigolo" ./pipeline.sh  # or any wigolo entry point
#
# Requires: node >= 20, jq.
set -euo pipefail

WIGOLO="${WIGOLO:-npx wigolo}"

echo "== 1. batch: two searches through ONE process, one JSON doc per line =="
$WIGOLO shell --json 2>/dev/null <<'EOF' \
  | jq -r 'select(.results) | .results[] | "\(.relevance_score * 100 | floor / 100)\t\(.url)"'
search "web components shadow dom" --limit 3 --no-content
search "css container queries" --limit 3 --no-content
EOF

echo
echo "== 2. mix tools in one pipe: fetch a page, then ask the cache =="
$WIGOLO shell --json 2>/dev/null <<'EOF' \
  | jq -c 'if .markdown then {title, chars: (.markdown | length), cached} elif .stats then .stats else . end'
fetch https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl
cache stats
EOF

echo
echo "== 3. exit code: any failed command fails the whole pipe =="
set +e
printf 'fetch https://no-such-host.invalid\n' | $WIGOLO shell --json 2>/dev/null | jq -c '{url, error}'
code=$?
set -e
echo "pipeline exit code: $code"
