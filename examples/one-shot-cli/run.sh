#!/usr/bin/env bash
# one-shot CLI: search, fetch, and research from a plain terminal.
# Every wigolo tool is also a one-shot command — no server, no session.
#
#   ./run.sh                  # uses `npx wigolo` (or `wigolo` if installed globally)
#   WIGOLO="wigolo" ./run.sh  # point at any wigolo binary/entry you prefer
#
# Requires: node >= 20, jq (for the JSON moment at the end).
set -euo pipefail

WIGOLO="${WIGOLO:-npx wigolo}"

echo "== 1. search: ranked results with evidence scores =="
$WIGOLO search "css grid layout guide" --max-results 5

echo
echo "== 2. fetch: any URL as clean markdown =="
$WIGOLO fetch https://developer.mozilla.org/en-US/docs/Web/API/structuredClone

echo
echo "== 3. research: a structured brief, piped through jq =="
$WIGOLO research "how does sqlite full text search work" --depth quick --json \
  | jq -r '.brief.highlights[0].text'
