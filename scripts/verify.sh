#!/usr/bin/env bash
# scripts/verify.sh
# Outer loop verifier — full pipeline. ~5–10 minutes per iteration.
#
# Flow:
#   1. Lint check (same as inner)
#   2. Build + install dev path
#   3. Bounce daemon (some engine code is shared with MCP)
#   4. Run benchmark through real Claude Code MCP path against all 4 tools
#   5. Print headline score
#
# Use sparingly — once or twice per day, or at autoresearch plateau checkpoints.

set -euo pipefail
cd "$(dirname "$0")/.."

BENCH_DIR="${WIGOLO_BENCH_DIR:-../wigolo-bench}"

# 1. Lint
LINT_PATTERN='from\s+["\047](openai|@anthropic-ai/sdk|@google/generative-ai|cohere-ai|@mistralai/mistralai|together-ai)["\047]|require\(["\047](openai|@anthropic-ai/sdk|@google/generative-ai|cohere-ai|@mistralai/mistralai|together-ai)["\047]\)'
if command -v rg >/dev/null 2>&1; then
  if rg -l -g '!src/integrations/cloud/**' "$LINT_PATTERN" src/ 2>/dev/null; then
    echo "[verify] REJECTED: cloud-LLM SDK in core path" >&2
    exit 2
  fi
fi

# 2. Build
echo "[verify] build"
./scripts/build_and_install_dev.sh

# 3. Daemon
echo "[verify] daemon"
./scripts/start_daemon.sh

# 4. Bench (all four tools, via MCP)
EXTRA_ARGS=""
if [[ -n "${WIGOLO_VERIFY_SUBSET:-}" ]]; then
  EXTRA_ARGS="$EXTRA_ARGS --subset $WIGOLO_VERIFY_SUBSET"
fi
if [[ -n "${WIGOLO_VERIFY_QUERIES:-}" ]]; then
  EXTRA_ARGS="$EXTRA_ARGS --queries $WIGOLO_VERIFY_QUERIES"
fi
echo "[verify] bench ($EXTRA_ARGS)"
cd "$BENCH_DIR"
./harness/run_bench.sh $EXTRA_ARGS

# 5. Score
SCORE=$(jq -r '.score' results/latest/aggregate.json)
WINS=$(jq -r '.wins_by_tool | to_entries | map("\(.key)=\(.value)") | join(" ")' results/latest/aggregate.json)
echo "[verify] score=$SCORE"
echo "[verify] wins: $WINS"
echo "$SCORE"
