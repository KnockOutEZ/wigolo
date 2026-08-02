#!/usr/bin/env bash
# Watch a changelog for changes: register a watch job, list it, run an
# on-demand check, and render the kind of diff report a change produces.
#
#   ./watch.sh                          # uses `npx wigolo`
#   WIGOLO="wigolo" ./watch.sh          # or any wigolo entry point
#   URL=https://your-site/changelog ./watch.sh
#
# Requires: node >= 20, jq.
set -euo pipefail

WIGOLO="${WIGOLO:-npx wigolo}"
URL="${URL:-https://nodejs.org/en/blog}"

echo "== 1. register a watch on ${URL} =="
JOB=$($WIGOLO watch add "$URL" --interval 3600 --json 2>/dev/null | jq -r '.job.id')
echo "job id: ${JOB}"
# Webhook variant: deliver every change report as a POST to your endpoint.
#   $WIGOLO watch add "$URL" --interval 3600 --notify https://hooks.example.com/wigolo
# The webhook target must be a public http(s) endpoint — loopback and private
# addresses are refused by the SSRF guard (see README).

echo
echo "== 2. list registered jobs =="
$WIGOLO watch list --json 2>/dev/null \
  | jq -r '.jobs[] | "\(.id[:12])…  \(.status)  every \(.interval_seconds)s  \(.url)"'

echo
echo "== 3. on-demand check (first check records the baseline) =="
$WIGOLO watch run "$JOB" --json 2>/dev/null \
  | jq '.changes_since_last[0] | {url, changed, current_hash: (.current_hash // "" | .[:12])}'

echo
echo "== 4. what a change looks like: the diff engine's report =="
$WIGOLO diff \
  --old "## v2.4.0
- Added container queries guide
- Fixed typo in grid docs" \
  --new "## v2.5.0
- Added container queries guide
- Added subgrid examples
- Fixed typo in grid docs" \
  --output unified --json 2>/dev/null | jq -r '.unified_diff'

echo
echo "== 5. clean up =="
$WIGOLO watch rm "$JOB" --json 2>/dev/null | jq -c '{removed_jobs: (.jobs | length)}'
