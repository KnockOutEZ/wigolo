#!/usr/bin/env bash
#
# verify-channel-docker.sh — local, no-push verification of the Docker channel.
#
# Builds BOTH image targets locally via buildx --load (NEVER --push) and exercises
# the P1 lazy-browser contract inside the containers:
#
#   arm64 default : `doctor` green (post-D5 lazy contract) + a browser-engine
#                   warmup as USER node, proving the first-use browser-binary
#                   download, the baked OS libraries (launch smoke-test), and
#                   graceful sudo-probe handling all work. A real JS-render fetch
#                   captures the organic first-run UX.
#   arm64 full    : `doctor` + a fetch (browser preinstalled, no download).
#   amd64 default : boot-level `doctor` only, under emulation (caveat documented).
#
# The warmup path is the authoritative lazy-browser proof: `runWarmup` runs the
# browser install + linux-deps strategy + launch smoke-test unconditionally, and
# `--json` reports playwright:"ok"|"failed". A CLI fetch cannot force the browser
# tier (no --render flag; the router escalates on page signals), so warmup is the
# deterministic check and the fetch is the UX capture.
#
# Emits a human-readable log to stdout and a machine-checkable summary at the end.
# Exit 0 only if every REQUIRED check passes. amd64 emulation is best-effort: if
# unavailable on this machine it is reported UNVERIFIED, not failed.
#
# Usage:  scripts/verify-channel-docker.sh
# Env:    IMAGE_BASE (default: wigolo-verify) — local image name prefix.
#         RENDER_URL (default: https://react.dev) — JS-heavy page for the fetch.

set -euo pipefail

IMAGE_BASE="${IMAGE_BASE:-wigolo-verify}"
RENDER_URL="${RENDER_URL:-https://react.dev}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Track pass/fail per named check. Parallel indexed arrays keep this portable to
# bash 3.2 (macOS default), which has no associative arrays.
CHECK_NAMES=()
CHECK_STATUS=()
FAILED=0

record() { CHECK_NAMES+=("$1"); CHECK_STATUS+=("$2"); }
pass()       { record "$1" PASS;       printf '  [PASS] %s\n' "$1"; }
fail()       { record "$1" FAIL; FAILED=1; printf '  [FAIL] %s\n' "$1"; }
unverified() { record "$1" UNVERIFIED;           printf '  [UNVERIFIED] %s — %s\n' "$1" "${2:-}"; }

# Echo the recorded status for a check name (empty if not yet recorded).
status_of() {
  local i
  for i in "${!CHECK_NAMES[@]}"; do
    if [[ "${CHECK_NAMES[$i]}" == "$1" ]]; then
      printf '%s' "${CHECK_STATUS[$i]}"
      return 0
    fi
  done
  printf ''
}

section() { printf '\n==== %s ====\n' "$1"; }

# ---------------------------------------------------------------------------
# 0. Preconditions
# ---------------------------------------------------------------------------
section "Preconditions"
if ! docker buildx version >/dev/null 2>&1; then
  echo "docker buildx not available — cannot run channel verification." >&2
  exit 2
fi
echo "docker: $(docker --version)"
echo "buildx: $(docker buildx version | head -n1)"

DEFAULT_IMG="${IMAGE_BASE}:default"
FULL_IMG="${IMAGE_BASE}:full"
DEFAULT_AMD64_IMG="${IMAGE_BASE}:default-amd64"
DATA_VOL="${IMAGE_BASE}-default-data"

# Start from a clean volume so the browser download is genuinely a FIRST-USE
# download (not a replay from a previous run).
docker volume rm "$DATA_VOL" >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
# 1. Build both targets for the native arch (arm64 here), loaded into docker.
# ---------------------------------------------------------------------------
section "Build (arm64 native, --load)"

echo "Building default target -> ${DEFAULT_IMG}"
if docker buildx build --target default --load -t "$DEFAULT_IMG" . ; then
  pass "build:arm64:default"
else
  fail "build:arm64:default"
fi

echo "Building full target -> ${FULL_IMG}"
if docker buildx build --target full --load -t "$FULL_IMG" . ; then
  pass "build:arm64:full"
else
  fail "build:arm64:full"
fi

# ---------------------------------------------------------------------------
# 2. arm64 default: doctor green
# ---------------------------------------------------------------------------
section "arm64 default: doctor"
if [[ "$(status_of build:arm64:default)" == "PASS" ]]; then
  if docker run --rm -v "${DATA_VOL}:/data" "$DEFAULT_IMG" doctor ; then
    pass "doctor:arm64:default"
  else
    fail "doctor:arm64:default"
  fi
else
  unverified "doctor:arm64:default" "build failed"
fi

# ---------------------------------------------------------------------------
# 3. arm64 default: browser-engine warmup as USER node — the authoritative proof
#    of lazy binary download + baked-libs launch smoke-test + sudo handling.
# ---------------------------------------------------------------------------
section "arm64 default: browser warmup (lazy download + launch smoke-test)"
if [[ "$(status_of build:arm64:default)" == "PASS" ]]; then
  WARM_LOG="$(mktemp)"
  set +e
  # Confirm we run as the non-root node user, then warm ONLY the browser. The
  # image ENTRYPOINT is `node dist/index.js`, so override it to run a shell.
  docker run --rm -v "${DATA_VOL}:/data" --entrypoint sh "$DEFAULT_IMG" \
    -c 'echo "whoami=$(id -un) uid=$(id -u)"; node dist/index.js warmup --browser --json' \
    >"$WARM_LOG" 2>&1
  WARM_CODE=$?
  set -e
  echo "--- first-run warmup output (trimmed) ---"
  head -c 2500 "$WARM_LOG"
  echo
  echo "--- (exit ${WARM_CODE}) ---"
  # Success: ran as node (uid != 0), playwright installed ok, no missing-libs error.
  if [[ $WARM_CODE -eq 0 ]] \
     && grep -q 'whoami=node' "$WARM_LOG" \
     && grep -q '"playwright":"ok"' "$WARM_LOG" \
     && ! grep -qi 'system libraries missing' "$WARM_LOG" ; then
    pass "warmup:arm64:default"
  else
    fail "warmup:arm64:default"
  fi
  rm -f "$WARM_LOG"
else
  unverified "warmup:arm64:default" "build failed"
fi

# ---------------------------------------------------------------------------
# 3b. Explicit sudo-ABSENT graceful-handling proof. The image ships NO sudo, so
#     the deps-strategy probe hits a raw spawn ENOENT — which the warmup code
#     must swallow as the 'skip' strategy (never crash). Two assertions:
#       (a) sudo really is absent and a raw spawn surfaces ENOENT;
#       (b) despite that, step 3's warmup already exited 0 with playwright ok.
# ---------------------------------------------------------------------------
section "arm64 default: sudo-absent graceful handling (as node)"
if [[ "$(status_of build:arm64:default)" == "PASS" ]]; then
  SUDO_LOG="$(mktemp)"
  set +e
  # Override the ENTRYPOINT (`node dist/index.js`) to run node directly.
  docker run --rm --user node --entrypoint node "$DEFAULT_IMG" \
    -e 'const{spawnSync}=require("child_process");const r=spawnSync("sudo",["-n","true"],{timeout:5000});console.log("sudo_status="+r.status+" spawn_error="+(r.error?r.error.code:"none"));process.exit(0)' \
    >"$SUDO_LOG" 2>&1
  SUDO_CODE=$?
  set -e
  echo "--- sudo probe output ---"
  cat "$SUDO_LOG"
  # (a) raw spawn shows ENOENT (sudo truly absent) and the probing process
  #     itself did not crash; (b) the warmup in step 3 (which exercises the real
  #     detectDepsStrategy path over this exact ENOENT) passed.
  if [[ $SUDO_CODE -eq 0 ]] \
     && grep -q 'spawn_error=ENOENT' "$SUDO_LOG" \
     && [[ "$(status_of warmup:arm64:default)" == "PASS" ]]; then
    pass "sudo-absent:arm64:default"
  else
    fail "sudo-absent:arm64:default"
  fi
  rm -f "$SUDO_LOG"
else
  unverified "sudo-absent:arm64:default" "build failed"
fi

# ---------------------------------------------------------------------------
# 3c. arm64 default: organic JS-render fetch as USER node — first-run UX capture.
#     The browser binary was warmed in step 3, so this reuses the volume binary.
# ---------------------------------------------------------------------------
section "arm64 default: JS-render fetch (organic, reuses warmed binary)"
if [[ "$(status_of warmup:arm64:default)" == "PASS" ]]; then
  FETCH_LOG="$(mktemp)"
  set +e
  docker run --rm -v "${DATA_VOL}:/data" "$DEFAULT_IMG" \
    fetch "$RENDER_URL" --mode=markdown --json >"$FETCH_LOG" 2>&1
  FETCH_CODE=$?
  set -e
  echo "--- fetch output (trimmed) ---"
  head -c 1500 "$FETCH_LOG"
  echo
  echo "--- (exit ${FETCH_CODE}) ---"
  if [[ $FETCH_CODE -eq 0 ]] && grep -qiE '"content"|markdown|react' "$FETCH_LOG" ; then
    pass "fetch:arm64:default"
  else
    fail "fetch:arm64:default"
  fi
  rm -f "$FETCH_LOG"
else
  unverified "fetch:arm64:default" "warmup did not pass"
fi

# ---------------------------------------------------------------------------
# 4. arm64 full: doctor + fetch (browser preinstalled, no download expected)
# ---------------------------------------------------------------------------
section "arm64 full: doctor"
if [[ "$(status_of build:arm64:full)" == "PASS" ]]; then
  if docker run --rm "$FULL_IMG" doctor ; then
    pass "doctor:arm64:full"
  else
    fail "doctor:arm64:full"
  fi
else
  unverified "doctor:arm64:full" "build failed"
fi

section "arm64 full: JS-render fetch (browser preinstalled)"
if [[ "$(status_of build:arm64:full)" == "PASS" ]]; then
  FETCH_LOG="$(mktemp)"
  set +e
  docker run --rm "$FULL_IMG" fetch "$RENDER_URL" --mode=markdown --json >"$FETCH_LOG" 2>&1
  FETCH_CODE=$?
  set -e
  echo "--- full fetch output (trimmed) ---"
  head -c 1500 "$FETCH_LOG"
  echo
  echo "--- (exit ${FETCH_CODE}) ---"
  if [[ $FETCH_CODE -eq 0 ]] && grep -qiE '"content"|markdown|react' "$FETCH_LOG" ; then
    pass "fetch:arm64:full"
  else
    fail "fetch:arm64:full"
  fi
  rm -f "$FETCH_LOG"
else
  unverified "fetch:arm64:full" "build failed"
fi

# ---------------------------------------------------------------------------
# 5. amd64 default (emulated): boot-level doctor only. Best-effort.
# ---------------------------------------------------------------------------
section "amd64 default (emulated): boot-level doctor"
if docker buildx build --platform linux/amd64 --target default --load \
     -t "$DEFAULT_AMD64_IMG" . >/dev/null 2>&1; then
  set +e
  docker run --rm --platform linux/amd64 -v "${IMAGE_BASE}-amd64-data:/data" \
    "$DEFAULT_AMD64_IMG" doctor
  AMD_CODE=$?
  set -e
  if [[ $AMD_CODE -eq 0 ]]; then
    pass "doctor:amd64:default"
  else
    unverified "doctor:amd64:default" "emulated doctor exited ${AMD_CODE} (qemu caveat)"
  fi
else
  unverified "doctor:amd64:default" "amd64 emulated build unavailable on this machine"
fi

# ---------------------------------------------------------------------------
# 6. Image sizes (informational)
# ---------------------------------------------------------------------------
section "Image sizes"
docker images "$IMAGE_BASE" --format '  {{.Repository}}:{{.Tag}} {{.Size}}' || true

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
section "Summary"
for i in "${!CHECK_NAMES[@]}"; do
  printf '  %-28s %s\n' "${CHECK_NAMES[$i]}" "${CHECK_STATUS[$i]}"
done | sort

if [[ $FAILED -ne 0 ]]; then
  echo
  echo "RESULT: FAIL — one or more required checks failed."
  exit 1
fi
echo
echo "RESULT: PASS — all required checks passed (amd64 emulation may be UNVERIFIED)."
exit 0
