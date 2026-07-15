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

WORK="$(mktemp -d)"
cleanup() {
  brew uninstall --force wigolo >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# 1. Pack the repo into a local tarball.
echo "==> npm pack"
PACK_JSON="$(cd "$REPO_ROOT" && npm pack --json --pack-destination "$WORK" 2>/dev/null)"
TARBALL="$WORK/$(node -e "process.stdout.write(JSON.parse(process.argv[1])[0].filename)" "$PACK_JSON")"
[ -f "$TARBALL" ] || { echo "FAIL: tarball not produced"; exit 1; }
echo "    tarball: $TARBALL"

# 2. Temp formula: file:// url + real sha256.
SHA="$(shasum -a 256 "$TARBALL" | awk '{print $1}')"
echo "==> tarball sha256: $SHA"
TEMP_FORMULA="$WORK/wigolo.rb"
sed \
  -e "s#url \".*\"#url \"file://$TARBALL\"#" \
  -e "s#sha256 \".*\"#sha256 \"$SHA\"#" \
  "$FORMULA_SRC" > "$TEMP_FORMULA"

# 3. Build from source. Local-path installs need --formula.
echo "==> brew install --build-from-source --formula $TEMP_FORMULA"
START=$(date +%s)
brew install --build-from-source --formula "$TEMP_FORMULA" 2>&1 | tee "$WORK/install.log"
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
CELLAR="$(brew --cellar wigolo)/$( "$BIN" --version | tr -d '[:space:]')"
BS3="$(find "$CELLAR" -type d -name better-sqlite3 2>/dev/null | head -1 || true)"
if [ -n "$BS3" ]; then
  if find "$BS3/build" -name '*.o' 2>/dev/null | grep -q .; then
    echo "    better-sqlite3: NODE-GYP SOURCE BUILD (found *.o objects under build/)"
  elif [ -f "$BS3/build/Release/better_sqlite3.node" ]; then
    echo "    better-sqlite3: PREBUILT (.node present, no *.o object files)"
  else
    echo "    better-sqlite3: present but build state indeterminate at $BS3"
  fi
else
  echo "    better-sqlite3 dir not located under $CELLAR"
fi

echo "==> ALL CHECKS PASSED (cleanup uninstalls on exit)"
