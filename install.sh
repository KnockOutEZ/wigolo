#!/bin/sh
# wigolo installer — single-binary mini-spec §5.
#
#   curl -fsSL https://raw.githubusercontent.com/KnockOutEZ/wigolo/studio-handoff-core/install.sh | sh
#
# It downloads the standalone wigolo build for your platform, checks it against the
# published checksum BEFORE unpacking it, unpacks it under your home directory and puts
# a link on your PATH. No package manager, no root, nothing touched outside your home.
#
# WHAT THIS SCRIPT FRONTS. Exactly the release artifacts described by mini-spec §4:
# `wigolo-<semver>-<platform>-<arch>.tar.gz` plus one `SHA256SUMS` covering all of them,
# published as release assets. There is no second build path here — this file downloads,
# verifies and places; it never compiles anything.
#
# WHY EVERY FAILURE PRINTS THE SAME FALLBACK LINE. This channel has more ways to be
# unavailable than the package channel does: a platform with no artifact, a proxy that
# eats the download, a machine with no checksum tool. A user who hits any of them still
# wants the tool, and the package channel installs the same one. So `fail` — the ONLY
# way this script exits non-zero — always prints it. That is a structural guarantee, not
# a habit: `tests/unit/binary/install-sh.test.ts` reds if an `exit 1` appears anywhere
# else in this file.
#
# Environment overrides:
#   WIGOLO_VERSION        install this version instead of the latest release
#   WIGOLO_INSTALL_DIR    install root (default: $HOME/.wigolo)
#   WIGOLO_RELEASE_BASE   where the release assets live (default: the GitHub release
#                         download base). The one seam the offline smoke drives.
#   WIGOLO_RELEASE_TAG    the release tag the assets hang under (default: v$VERSION).
#                         A release whose tag is not the version spelled `v<semver>`
#                         is otherwise unreachable: the artifact names carry the bare
#                         semver but the download path carries the tag, and only the
#                         publisher knows they differ. The binary-only prerelease
#                         channel (`binary-v*`, mini-spec §4) is exactly that case.
#   WIGOLO_LATEST_URL     where "latest" is resolved from, when WIGOLO_VERSION is unset
#   HTTPS_PROXY/https_proxy honoured by the downloader
#
# POSIX sh. `set -eu`; no pipefail (not POSIX).

set -eu

REPO="KnockOutEZ/wigolo"
RELEASE_BASE="${WIGOLO_RELEASE_BASE:-https://github.com/$REPO/releases/download}"
LATEST_URL="${WIGOLO_LATEST_URL:-https://api.github.com/repos/$REPO/releases/latest}"
NPM_FALLBACK="npm install -g wigolo"

INSTALL_DIR="${WIGOLO_INSTALL_DIR:-$HOME/.wigolo}"
LINK_DIR="$HOME/.local/bin"
LINK="$LINK_DIR/wigolo"
TMP_DIR=""

# ---------------------------------------------------------------------------
# Output. Everything human-readable goes to stderr so stdout stays empty and this
# script composes inside a pipeline without polluting it.
# ---------------------------------------------------------------------------
info() { printf '%s\n' "$*" >&2; }
step() { printf '\n==> %s\n' "$*" >&2; }

# The single exit-non-zero path in this file (see the header note).
fail() {
  printf '\nerror: %s\n' "$*" >&2
  printf '\nThe package channel installs the same tool and does not need this download:\n  %s\n' \
    "$NPM_FALLBACK" >&2
  exit 1
}

cleanup() {
  if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then
    rm -rf "$TMP_DIR"
  fi
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------------------
# Downloader. curl or wget, whichever is present; both read the standard proxy vars.
# ---------------------------------------------------------------------------
DL_TOOL=""
detect_downloader() {
  if command -v curl >/dev/null 2>&1; then
    DL_TOOL="curl"
  elif command -v wget >/dev/null 2>&1; then
    DL_TOOL="wget"
  else
    fail "no download tool found — install curl or wget and re-run."
  fi
}

# download <url> <dest-file>  — non-zero on failure, so callers can probe as well as insist.
download() {
  if [ "$DL_TOOL" = "curl" ]; then
    curl -fsSL --retry 3 -o "$2" "$1"
  else
    wget -q -O "$2" "$1"
  fi
}

# ---------------------------------------------------------------------------
# Checksums. Fail closed: no tool means no verification means no install (§4 G4).
# ---------------------------------------------------------------------------
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{ print $1 }'
  else
    fail "no checksum tool found (sha256sum or shasum) — refusing to install an unverified download."
  fi
}

# ---------------------------------------------------------------------------
# Platform. `uname` is the whole detector; the names it maps to are the §1/§4 spellings.
# ---------------------------------------------------------------------------
OS=""
ARCH=""
detect_platform() {
  uname_s="$(uname -s 2>/dev/null || echo unknown)"
  uname_m="$(uname -m 2>/dev/null || echo unknown)"

  case "$uname_s" in
    Linux) OS="linux" ;;
    Darwin) OS="darwin" ;;
    MINGW* | MSYS* | CYGWIN* | Windows_NT)
      fail "this script installs on macOS and Linux only. On Windows, download the .zip asset from
the releases page and unpack it yourself, or use the package channel below."
      ;;
    *)
      fail "unsupported operating system: $uname_s."
      ;;
  esac

  case "$uname_m" in
    x86_64 | amd64) ARCH="x64" ;;
    arm64 | aarch64) ARCH="arm64" ;;
    *)
      fail "there is no build for this processor architecture: $uname_m."
      ;;
  esac

  if [ "$OS" = "linux" ]; then
    refuse_musl
  fi
}

# musl / Alpine. The builds link against glibc, so a musl machine would get an artifact
# that unpacks cleanly and then cannot start — refuse up front and name the reason.
#
# Three probes because no single one is reliable: Alpine's marker file, `ldd --version`
# (musl prints its name there and exits non-zero doing it, which the pipe hides), and the
# musl loader itself for a musl system with neither of the first two.
refuse_musl() {
  is_musl=0
  if [ -f /etc/alpine-release ]; then
    is_musl=1
  elif command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; then
    is_musl=1
  else
    for loader in /lib/ld-musl-*.so.1; do
      if [ -e "$loader" ]; then
        is_musl=1
      fi
    done
  fi

  if [ "$is_musl" -eq 1 ]; then
    fail "this build needs glibc, and this machine uses musl (Alpine and friends).
Run it in a glibc-based container, or use the package channel below."
  fi
}

# ---------------------------------------------------------------------------
# Version. Explicit wins; otherwise ask the release feed which one is latest.
# ---------------------------------------------------------------------------
VERSION=""
TAG=""
resolve_version() {
  VERSION="${WIGOLO_VERSION:-}"
  if [ -z "$VERSION" ]; then
    step "Looking up the latest version"
    download "$LATEST_URL" "$TMP_DIR/latest.json" \
      || fail "could not reach the release feed to find the latest version."
    VERSION="$(
      tr ',' '\n' < "$TMP_DIR/latest.json" \
        | grep '"tag_name"' \
        | head -n 1 \
        | sed -e 's/.*"tag_name"[[:space:]]*:[[:space:]]*"//' -e 's/".*//'
    )"
    [ -n "$VERSION" ] || fail "the release feed did not name a latest version."
  fi
  # Accept `v0.2.1` and `0.2.1` from either source; the artifact names carry the bare
  # semver and the tag carries the `v`.
  VERSION="${VERSION#v}"
  # The tag is a separate fact from the version, not a rendering of it. They agree for
  # every `v<semver>` release, which is why one variable looked like enough — but the
  # asset NAME is built from the version and the asset PATH from the tag, so a release
  # published under any other tag has assets nothing here could address.
  TAG="${WIGOLO_RELEASE_TAG:-v$VERSION}"
}

# ---------------------------------------------------------------------------
# Install
# ---------------------------------------------------------------------------
link_and_report() {
  target="$1"

  mkdir -p "$LINK_DIR"
  ln -sf "$target" "$LINK"

  info ""
  info "wigolo $VERSION is installed."
  info "  binary: $target"
  info "  link:   $LINK"

  case ":${PATH:-}:" in
    *":$LINK_DIR:"*)
      info ""
      info "Run it:  wigolo --version"
      ;;
    *)
      info ""
      info "$LINK_DIR is not on your PATH yet. Add this to your shell profile:"
      info "  export PATH=\"\$HOME/.local/bin:\$PATH\""
      info ""
      info "Until then, use the full path:  $LINK --version"
      ;;
  esac

  info ""
  info "Wire it into an agent with the ABSOLUTE path — agent clients do not read your shell PATH:"
  info "  claude mcp add wigolo -- $LINK"
}

main() {
  for arg in "$@"; do
    case "$arg" in
      -h | --help)
        info "wigolo installer"
        info "  (no arguments)  install the latest release under $INSTALL_DIR"
        info ""
        info "  WIGOLO_VERSION      install a specific version"
        info "  WIGOLO_INSTALL_DIR  install somewhere other than \$HOME/.wigolo"
        exit 0
        ;;
      *)
        fail "unknown argument: $arg (try --help)."
        ;;
    esac
  done

  detect_downloader
  detect_platform

  TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/wigolo-install.XXXXXX")" \
    || fail "could not create a temporary directory."

  resolve_version

  dist_dir="$INSTALL_DIR/dist/$VERSION"
  artifact="wigolo-$VERSION-$OS-$ARCH.tar.gz"

  # Idempotent re-run: the version is already unpacked, so re-point the link and stop.
  # Deliberately BEFORE the download — re-running the one-liner must not re-fetch ~100 MB
  # to arrive at the state it is already in.
  if [ -x "$dist_dir/bin/wigolo" ]; then
    step "wigolo $VERSION is already installed in $dist_dir"
    link_and_report "$dist_dir/bin/wigolo"
    exit 0
  fi

  step "Installing wigolo $VERSION for $OS/$ARCH"

  download "$RELEASE_BASE/$TAG/SHA256SUMS" "$TMP_DIR/SHA256SUMS" \
    || fail "could not download the checksum file for $TAG."
  download "$RELEASE_BASE/$TAG/$artifact" "$TMP_DIR/$artifact" \
    || fail "could not download $artifact — there may be no build for $OS/$ARCH in $TAG."

  step "Verifying the download"
  # `$2 == name` rather than a regex: SHA256SUMS is `<hex>  <name>`, two spaces, and
  # matching on the second field is immune to how many spaces a future writer uses.
  expected="$(awk -v name="$artifact" '$2 == name { print $1; exit }' "$TMP_DIR/SHA256SUMS")"
  [ -n "$expected" ] || fail "SHA256SUMS for $TAG has no entry for $artifact."
  actual="$(sha256_of "$TMP_DIR/$artifact")"
  if [ "$actual" != "$expected" ]; then
    fail "checksum mismatch for $artifact
  expected: $expected
  actual:   $actual
These are not the published bytes. Nothing was unpacked."
  fi
  info "Checksum OK."

  step "Unpacking into $dist_dir"
  mkdir -p "$TMP_DIR/unpack"
  tar -xzf "$TMP_DIR/$artifact" -C "$TMP_DIR/unpack" \
    || fail "could not unpack $artifact."

  staged="$TMP_DIR/unpack/wigolo"
  [ -x "$staged/bin/wigolo" ] || fail "$artifact does not contain bin/wigolo."
  [ -f "$staged/VERSION" ] || fail "$artifact does not contain a VERSION file."

  # §4 G5 — the version inside the archive must be the version we asked for. A mismatch
  # means the asset under that name is not the release it claims to be, and every later
  # answer (`wigolo --version`, the directory it lives in) would be a lie.
  got="$(awk -F= '$1 == "semver" { print $2; exit }' "$staged/VERSION")"
  if [ "$got" != "$VERSION" ]; then
    fail "$artifact says it is version $got, but it was published as $VERSION."
  fi

  mkdir -p "$INSTALL_DIR/dist"
  rm -rf "$dist_dir"
  mv "$staged" "$dist_dir"

  link_and_report "$dist_dir/bin/wigolo"
}

main "$@"
