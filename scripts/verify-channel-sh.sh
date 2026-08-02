#!/usr/bin/env bash
# Local verification for the curl|sh install channel (spec D2, slice S-P1-SH).
#
# Runs entirely offline of the npm registry: builds a local `npm pack` tarball
# and installs from it via WIGOLO_INSTALL_SOURCE into a sandboxed prefix, then
# asserts the shim, version, doctor exit, upgrade re-run, and --uninstall
# data-preservation contract.
#
# The pinned Node runtime IS fetched from nodejs.org (checksum-verified by the
# installer). Requires network for that step.
#
# Usage: scripts/verify-channel-sh.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INSTALLER="$REPO_ROOT/packaging/install.sh"

log() { printf '\n### %s\n' "$*"; }
fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

[ -f "$INSTALLER" ] || fail "installer not found: $INSTALLER"

PKG_VERSION="$(node -e "process.stdout.write(require('$REPO_ROOT/package.json').version)")"
log "package.json version: $PKG_VERSION"

# --- shellcheck -----------------------------------------------------------
if command -v shellcheck >/dev/null 2>&1; then
  log "shellcheck packaging/install.sh"
  shellcheck -s sh "$INSTALLER" || fail "shellcheck reported issues"
  echo "shellcheck: clean"
else
  echo "shellcheck: NOT INSTALLED (skipped — install for full coverage)"
fi

# --- sandbox --------------------------------------------------------------
SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/wigolo-verify-sh.XXXXXX")"
PREFIX="$SANDBOX/home/.wigolo"
cleanup() { rm -rf "$SANDBOX"; }
trap cleanup EXIT

# --- build local tarball --------------------------------------------------
log "npm pack (build + tarball)"
npm run build --prefix "$REPO_ROOT" >/dev/null 2>&1 || fail "build failed"
PACK_OUT="$(cd "$SANDBOX" && npm pack "$REPO_ROOT" 2>/dev/null | tail -n 1)"
TARBALL="$SANDBOX/$PACK_OUT"
[ -f "$TARBALL" ] || fail "npm pack tarball not found: $TARBALL"
echo "tarball: $TARBALL"

export WIGOLO_INSTALL_PREFIX="$PREFIX"
export WIGOLO_INSTALL_SOURCE="$TARBALL"

SHIM="$PREFIX/bin/wigolo"

# --- install --------------------------------------------------------------
log "install (from local tarball into sandbox prefix)"
sh "$INSTALLER" || fail "install exited non-zero"

[ -x "$SHIM" ] || fail "shim not created / not executable: $SHIM"
echo "shim: OK"

# Simulate user data so we can prove --uninstall preserves it.
mkdir -p "$PREFIX/cache" "$PREFIX/models"
touch "$PREFIX/cache/index.db" "$PREFIX/config.json"

log "wigolo --version matches package.json"
GOT_VERSION="$("$SHIM" --version 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+[^ ]*' | head -n 1)"
echo "shim --version: $GOT_VERSION"
[ "$GOT_VERSION" = "$PKG_VERSION" ] || fail "version mismatch: shim=$GOT_VERSION pkg=$PKG_VERSION"

log "wigolo doctor exit 0 (post-D5 lazy contract)"
if "$SHIM" doctor; then
  echo "doctor: exit 0"
else
  fail "doctor exited non-zero"
fi

# --- upgrade re-run (converges, no error) ---------------------------------
log "re-run install (upgrade path must converge without error)"
sh "$INSTALLER" || fail "upgrade re-run exited non-zero"
[ -x "$SHIM" ] || fail "shim missing after re-run"
echo "upgrade re-run: OK"

# --- uninstall ------------------------------------------------------------
log "install.sh --uninstall (must remove tool, preserve data)"
sh "$INSTALLER" --uninstall || fail "--uninstall exited non-zero"

[ ! -e "$PREFIX/bin" ] || fail "bin/ not removed by --uninstall"
[ ! -e "$PREFIX/tool" ] || fail "tool/ not removed by --uninstall"
[ ! -e "$PREFIX/runtime" ] || fail "runtime/ not removed by --uninstall"
[ -f "$PREFIX/cache/index.db" ] || fail "user cache DELETED by --uninstall (must preserve)"
[ -f "$PREFIX/config.json" ] || fail "user config DELETED by --uninstall (must preserve)"
echo "uninstall: tool/runtime/bin gone, data preserved"

log "ALL CHECKS PASSED"
