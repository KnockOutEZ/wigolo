#!/usr/bin/env bash
# Local verification for the single-file binary channel (spec D1, slice S-P1-BIN).
#
# Builds the binary via `npm run build:binary` (fresh dist -> esbuild CJS bundle
# -> @yao-pkg/pkg) and re-runs the S-P1-VAL assertion set (a)-(h) against the
# fresh binary, INCLUDING the sqlite-vec probe that failed in the validation
# gate (round 2). Each run uses a clean WIGOLO_DATA_DIR so nothing reads ~/.wigolo.
#
# Only the host arch is verified here (macOS arm64 in the reference run); the
# CI matrix (.github/workflows/binary-build.yml) covers the other platforms.
#
# Caveat (documented in packaging/verification/binary.md): browser:ok can
# partly reflect the machine-level ms-playwright cache, which lives OUTSIDE
# WIGOLO_DATA_DIR. Gatekeeper/notarization is a release-time concern.
#
# Usage: scripts/verify-channel-binary.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$REPO_ROOT/packaging/binary/dist/wigolo"

PASS=0
FAILN=0
log()  { printf '\n### %s\n' "$*"; }
ok()   { printf 'PASS: %s\n' "$*"; PASS=$((PASS + 1)); }
bad()  { printf 'FAIL: %s\n' "$*" >&2; FAILN=$((FAILN + 1)); }

freshdir() { mktemp -d "${TMPDIR:-/tmp}/wigolo-verify-bin.XXXXXX"; }

PKG_VERSION="$(node -e "process.stdout.write(require('$REPO_ROOT/package.json').version)")"
log "package.json version: $PKG_VERSION"

# --- build ----------------------------------------------------------------
log "npm run build:binary (fresh dist -> bundle -> pkg)"
( cd "$REPO_ROOT" && npm run build:binary ) || { bad "build:binary failed"; exit 1; }
[ -x "$BIN" ] || { bad "binary not found / not executable: $BIN"; exit 1; }

SIZE_BYTES="$(wc -c < "$BIN" | tr -d ' ')"
SIZE_MB="$(( SIZE_BYTES / 1024 / 1024 ))"
log "binary size: ${SIZE_MB} MB ($SIZE_BYTES bytes)"

# --- (a) --help exit 0 ----------------------------------------------------
log "(a) --help exit 0"
D="$(freshdir)"
if WIGOLO_DATA_DIR="$D" "$BIN" --help >/dev/null 2>&1; then
  ok "(a) --help exit 0"
else
  bad "(a) --help non-zero"
fi
rm -rf "$D"

# --- (b) --version == package.json ----------------------------------------
log "(b) --version == package.json"
D="$(freshdir)"
GOT="$(WIGOLO_DATA_DIR="$D" "$BIN" --version 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+[^ ]*' | head -n 1)"
echo "binary --version: $GOT"
if [ "$GOT" = "$PKG_VERSION" ]; then
  ok "(b) version matches ($GOT)"
else
  bad "(b) version mismatch: binary=$GOT pkg=$PKG_VERSION"
fi
rm -rf "$D"

# --- (c) doctor --json parses + exit --------------------------------------
log "(c) doctor --json parses"
D="$(freshdir)"
DOC_OUT="$(WIGOLO_DATA_DIR="$D" "$BIN" doctor --json 2>/dev/null || true)"
if node -e "JSON.parse(process.argv[1])" "$DOC_OUT" 2>/dev/null; then
  DSTATUS="$(node -e "process.stdout.write(String(JSON.parse(process.argv[1]).status))" "$DOC_OUT")"
  ok "(c) doctor --json parses (status=$DSTATUS)"
else
  bad "(c) doctor --json did not parse"
fi
rm -rf "$D"

# --- (d) cache write + sqlite-vec probe (the round-2 FAIL layer) -----------
log "(d) cache write + sqlite-vec vec_version / vec tables"
D="$(freshdir)"
FETCH_ERR="$D/fetch.err"
WIGOLO_DATA_DIR="$D" "$BIN" fetch https://example.com >/dev/null 2>"$FETCH_ERR" || bad "(d) fetch failed"
# Soft-fail signal must be ABSENT (extension loaded), and vec virtual tables
# must exist in the DB.
if grep -qiE 'sqlite-vec extension failed|vector search disabled|dylib\.dylib|no such table: vec_id_map' "$FETCH_ERR"; then
  bad "(d) sqlite-vec soft-fail signal present"
else
  # Prefer a real vec_version() probe via the sqlite3 CLI when available; else
  # assert the vec virtual tables the migration creates.
  if command -v sqlite3 >/dev/null 2>&1; then
    VECTABLES="$(sqlite3 "$D/wigolo.db" "SELECT count(*) FROM sqlite_master WHERE name LIKE 'vec_%';" 2>/dev/null || echo 0)"
    if [ "${VECTABLES:-0}" -gt 0 ]; then
      ok "(d) sqlite-vec loaded (vec tables present: $VECTABLES, no soft-fail)"
    else
      bad "(d) no vec_* tables — extension likely did not load"
    fi
  else
    ok "(d) sqlite-vec loaded (no soft-fail signal; sqlite3 CLI unavailable for vec_version)"
  fi
fi
# Confirm the extension was extracted to a REAL path under <dataDir>/native/.
if [ -f "$D/native/vec0.dylib" ] || [ -f "$D/native/vec0.so" ] || [ -f "$D/native/vec0.dll" ]; then
  ok "(d) extension copied out of snapshot to <dataDir>/native/"
else
  bad "(d) no extracted extension under <dataDir>/native/"
fi
rm -rf "$D"

# --- (e) real embed call (ORT .node + sibling dylib) ----------------------
log "(e) warmup --embeddings (real embed, ORT dylib extraction)"
D="$(freshdir)"
EMB_ERR="$D/embed.err"
if WIGOLO_DATA_DIR="$D" timeout 300 "$BIN" warmup --embeddings >/dev/null 2>"$EMB_ERR"; then
  if grep -qiE 'Embedding model ready|Embeddings:\s+ok' "$EMB_ERR"; then
    ok "(e) embeddings ready (ORT + sibling dylib load OK)"
  else
    bad "(e) warmup --embeddings exit 0 but no 'ready' signal"
  fi
else
  bad "(e) warmup --embeddings failed"
fi
rm -rf "$D"

# --- (f) mcp handshake + 10 tools -----------------------------------------
log "(f) mcp stdio handshake + ListTools"
D="$(freshdir)"
MCP_OUT="$(printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"verify","version":"1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | WIGOLO_DATA_DIR="$D" timeout 60 "$BIN" mcp 2>/dev/null)"
TOOLCOUNT="$(printf '%s' "$MCP_OUT" | node -e '
  let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
    for(const l of d.trim().split(/\n/)){try{const j=JSON.parse(l);
      if(j.id===2 && j.result && Array.isArray(j.result.tools)){console.log(j.result.tools.length);return;}}catch{}}
    console.log(0);
  });')"
if [ "${TOOLCOUNT:-0}" -eq 10 ]; then
  ok "(f) mcp handshake OK, 10 tools listed"
else
  bad "(f) mcp handshake listed ${TOOLCOUNT} tools (expected 10)"
fi
rm -rf "$D"

# --- (g) warmup --browser (execPath -> snapshot playwright cli spawn) ------
log "(g) warmup --browser (playwright cli spawn seam)"
D="$(freshdir)"
BROW_ERR="$D/brow.err"
if WIGOLO_DATA_DIR="$D" timeout 400 "$BIN" warmup --browser >/dev/null 2>"$BROW_ERR"; then
  if grep -qiE 'Browser:\s+ok|playwright installed' "$BROW_ERR"; then
    ok "(g) browser warmup OK (cli spawn seam works)"
  else
    bad "(g) warmup --browser exit 0 but no 'ok' signal"
  fi
else
  bad "(g) warmup --browser failed"
fi
rm -rf "$D"

# --- (h) Gatekeeper / quarantine (documentation-only on macOS) ------------
log "(h) Gatekeeper / quarantine (documented, not solved)"
if [ "$(uname -s)" = "Darwin" ]; then
  Q="$(mktemp "${TMPDIR:-/tmp}/wigolo-quarantined.XXXXXX")"
  cp "$BIN" "$Q"
  xattr -w com.apple.quarantine "0081;;;Safari" "$Q" 2>/dev/null || true
  if "$Q" --version >/dev/null 2>&1; then
    echo "(h) quarantined binary executed (host may have relaxed GK / already assessed)"
  else
    echo "(h) quarantined unsigned binary BLOCKED by Gatekeeper — needs release-time notarization"
  fi
  rm -f "$Q"
  ok "(h) documented"
else
  ok "(h) not macOS — Gatekeeper N/A"
fi

# --- (dist-freshness) binary --version == package.json (re-assert) --------
log "dist-freshness: binary --version == package.json"
D="$(freshdir)"
GOT2="$(WIGOLO_DATA_DIR="$D" "$BIN" --version 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+[^ ]*' | head -n 1)"
if [ "$GOT2" = "$PKG_VERSION" ]; then ok "dist-freshness: $GOT2"; else bad "dist-freshness mismatch: $GOT2 != $PKG_VERSION"; fi
rm -rf "$D"

log "SUMMARY: $PASS passed, $FAILN failed (binary ${SIZE_MB} MB, $(uname -s)/$(uname -m))"
[ "$FAILN" -eq 0 ] || exit 1
