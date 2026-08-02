#!/usr/bin/env bash
#
# verify-channel-brew.sh — local verification of the Homebrew formula.
#
# Packs the repo into a tarball, writes a TEMP copy of the formula pointing
# `url` at file://<tarball> with the tarball's real sha256 (the committed
# formula keeps the canonical registry URL + placeholder), builds it from
# source via brew, then asserts version + `wigolo doctor` exit 0 before
# uninstalling clean.
#
# Requires: brew on PATH. node@22 is pulled in as a formula dependency if
# absent (this can take a while — brew may build it from source).
#
# Usage: scripts/verify-channel-brew.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FORMULA_SRC="$REPO_ROOT/packaging/homebrew/wigolo.rb"

command -v brew >/dev/null 2>&1 || { echo "FAIL: brew not on PATH"; exit 1; }
[ -f "$FORMULA_SRC" ] || { echo "FAIL: formula not found at $FORMULA_SRC"; exit 1; }

EXPECTED_VERSION="$(node -e "process.stdout.write(require('$REPO_ROOT/package.json').version)")"
echo "==> package.json version: $EXPECTED_VERSION"

# Homebrew (6.x) refuses to install a formula from a bare path — it must live in
# a tap. We create an ephemeral local tap, drop the temp formula in it, install
# from there, then untap on cleanup.
LOCAL_TAP="wigolo-verify/local"

WORK="$(mktemp -d)"
cleanup() {
  brew uninstall --force wigolo >/dev/null 2>&1 || true
  brew untap "$LOCAL_TAP" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# 1. Pack the repo into a local tarball.
echo "==> npm pack"
PACK_JSON="$(cd "$REPO_ROOT" && npm pack --json --pack-destination "$WORK" 2>/dev/null)"
TARBALL="$WORK/$(node -e "process.stdout.write(JSON.parse(process.argv[1])[0].filename)" "$PACK_JSON")"
[ -f "$TARBALL" ] || { echo "FAIL: tarball not produced"; exit 1; }
echo "    tarball: $TARBALL"

# 2. Temp formula in an ephemeral local tap: file:// url + real sha256.
SHA="$(shasum -a 256 "$TARBALL" | awk '{print $1}')"
echo "==> tarball sha256: $SHA"
brew untap "$LOCAL_TAP" >/dev/null 2>&1 || true
brew tap-new --no-git "$LOCAL_TAP" >/dev/null 2>&1
TAP_DIR="$(brew --repository "$LOCAL_TAP")"
TEMP_FORMULA="$TAP_DIR/Formula/wigolo.rb"
mkdir -p "$TAP_DIR/Formula"
sed \
  -e "s#url \".*\"#url \"file://$TARBALL\"#" \
  -e "s#sha256 \".*\"#sha256 \"$SHA\"#" \
  "$FORMULA_SRC" > "$TEMP_FORMULA"

# 3. Build from source from the tap.
echo "==> brew install --build-from-source $LOCAL_TAP/wigolo"
START=$(date +%s)
brew install --build-from-source "$LOCAL_TAP/wigolo" 2>&1 | tee "$WORK/install.log"
echo "    install took $(( $(date +%s) - START ))s"

PREFIX="$(brew --prefix)"
BIN="$PREFIX/bin/wigolo"

# 4a. Version assertion.
echo "==> $BIN --version"
GOT_VERSION="$("$BIN" --version 2>&1 | tr -d '[:space:]')"
echo "    got: $GOT_VERSION  expected: $EXPECTED_VERSION"
case "$GOT_VERSION" in
  *"$EXPECTED_VERSION"*) echo "    PASS version" ;;
  *) echo "FAIL: version mismatch"; exit 1 ;;
esac

# 4b. doctor exit 0 (post-D5 lazy contract).
echo "==> wigolo doctor"
if "$BIN" doctor; then
  echo "    PASS doctor exit 0"
else
  echo "FAIL: doctor exited non-zero"; exit 1
fi

# 4c. better-sqlite3 prebuilt-vs-source report.
echo "==> better-sqlite3 build inspection"
CELLAR="$(brew --cellar wigolo)"
BS3="$(find "$CELLAR" -type d -name better-sqlite3 2>/dev/null | head -1 || true)"
if [ -n "$BS3" ]; then
  if [ ! -f "$BS3/build/Release/better_sqlite3.node" ]; then
    echo "FAIL: better-sqlite3 binding .node MISSING at $BS3/build/Release/ — cache subsystem will not load"
    exit 1
  elif find "$BS3/build" -name '*.o' 2>/dev/null | grep -q .; then
    echo "    better-sqlite3: NODE-GYP SOURCE BUILD (.node + *.o objects under build/)"
  else
    echo "    better-sqlite3: PREBUILT (.node present, no *.o object files → prebuild-install)"
  fi
else
  echo "FAIL: better-sqlite3 dir not located under $CELLAR"; exit 1
fi

echo "==> ALL CHECKS PASSED (cleanup uninstalls on exit)"
