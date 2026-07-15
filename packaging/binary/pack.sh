#!/usr/bin/env bash
# Package the wigolo CJS bundle into a single-file binary with @yao-pkg/pkg.
# Run AFTER `npm run build` + packaging/binary/bundle.mjs (build:binary chains
# all three). Binary-only build step; the npm/source path never runs it.
#
# Placement rationale (validated, see packaging/verification/binary.md):
#   - pkg resolves scripts/assets globs relative to the CONFIG file's directory,
#     so the config is copied to the repo root as pkg.build.json at build time.
#   - The bundle lives at dist/cli/agents/wigolo.bundle.cjs so the four
#     import.meta.url-relative package.json lookups in src resolve against real
#     files; two package.json depth shims (dist/ and dist/cli/) satisfy the two
#     intermediate depths, the repo-root package.json satisfies the deepest.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
OUT_DIR="$SCRIPT_DIR/dist"

BUNDLE="$REPO_ROOT/dist/cli/agents/wigolo.bundle.cjs"
if [ ! -f "$BUNDLE" ]; then
  echo "error: bundle not found at $BUNDLE — run 'node packaging/binary/bundle.mjs' first" >&2
  exit 1
fi

# package.json depth shims for the bundle's import.meta.url-relative lookups.
cp "$REPO_ROOT/package.json" "$REPO_ROOT/dist/package.json"
mkdir -p "$REPO_ROOT/dist/cli"
cp "$REPO_ROOT/package.json" "$REPO_ROOT/dist/cli/package.json"

# pkg reads globs relative to its config file's dir → keep the config at root.
cp "$SCRIPT_DIR/pkg.config.json" "$REPO_ROOT/pkg.build.json"

# Resolve the host pkg target (only the host arch is verified locally; the CI
# matrix covers the rest — see .github/workflows/binary-build.yml).
UNAME_S="$(uname -s)"
UNAME_M="$(uname -m)"
case "$UNAME_S" in
  Darwin) OS=macos ;;
  Linux)  OS=linux ;;
  *)      echo "error: unsupported host OS '$UNAME_S' for local binary build" >&2; exit 1 ;;
esac
case "$UNAME_M" in
  arm64|aarch64) ARCH=arm64 ;;
  x86_64|amd64)  ARCH=x64 ;;
  *)             echo "error: unsupported host arch '$UNAME_M'" >&2; exit 1 ;;
esac
TARGET="node22-${OS}-${ARCH}"
BIN_NAME="wigolo"
[ "$OS" = "win" ] && BIN_NAME="wigolo.exe"

mkdir -p "$OUT_DIR"
OUT_BIN="$OUT_DIR/$BIN_NAME"

echo "packing $TARGET -> $OUT_BIN"
npx @yao-pkg/pkg@6.21.0 "$BUNDLE" \
  --config "$REPO_ROOT/pkg.build.json" \
  --target "$TARGET" \
  --output "$OUT_BIN"

# Clean up the root-level build artifacts (shims + config) so they never leak.
rm -f "$REPO_ROOT/pkg.build.json" "$REPO_ROOT/dist/package.json" "$REPO_ROOT/dist/cli/package.json"

SIZE_BYTES="$(wc -c < "$OUT_BIN" | tr -d ' ')"
SIZE_MB="$(( SIZE_BYTES / 1024 / 1024 ))"
echo "built $OUT_BIN (${SIZE_MB} MB, target $TARGET)"
