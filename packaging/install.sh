#!/bin/sh
# wigolo bootstrap installer — local-first web intelligence for AI agents.
#
# Usage:
#   curl -fsSL https://wigolo.dev/install.sh | sh
#   sh install.sh --uninstall
#
# What it does:
#   1. Detects your OS + CPU and bails early (with guidance) on unsupported ones.
#   2. Installs wigolo under ~/.wigolo/ using a pinned, checksum-verified
#      language runtime — no system packages touched, no root required.
#   3. Writes a launcher at ~/.wigolo/bin/wigolo and prints how to wire it into
#      your AI agent.
#
# This does NOT need any API keys for core work. Optional cloud keys add
# answer synthesis; configure them later with `wigolo config`.
#
# Environment overrides (advanced / testing):
#   WIGOLO_INSTALL_PREFIX   install root (default: $HOME/.wigolo)
#   WIGOLO_INSTALL_SOURCE   install from a local package tarball instead of the
#                           registry (absolute path to a `npm pack` .tgz)
#   HTTPS_PROXY/https_proxy honored for all downloads
#
# POSIX sh. set -eu (no pipefail — not POSIX).

set -eu

# ---------------------------------------------------------------------------
# Pinned language runtime. Bump deliberately; both must move together.
# ---------------------------------------------------------------------------
NODE_VERSION="v22.23.1"
NODE_DIST_BASE="https://nodejs.org/dist"

PKG_NAME="wigolo"

# Canonical release location for future prebuilt binaries (not yet published;
# the runtime path below is the live path until a release ships them).
BIN_RELEASE_BASE="https://github.com/KnockOutEZ/wigolo/releases/latest/download"

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
PREFIX="${WIGOLO_INSTALL_PREFIX:-$HOME/.wigolo}"
BIN_DIR="$PREFIX/bin"
TOOL_DIR="$PREFIX/tool"
RUNTIME_DIR="$PREFIX/runtime"
TMP_DIR=""

# ---------------------------------------------------------------------------
# Output helpers (all to stderr so a piped install can stay quiet on stdout)
# ---------------------------------------------------------------------------
info() { printf '%s\n' "$*" >&2; }
step() { printf '\n==> %s\n' "$*" >&2; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then
    rm -rf "$TMP_DIR"
  fi
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------------------
# Download abstraction — curl or wget, HTTPS_PROXY honored automatically by
# both tools via the standard env vars.
# ---------------------------------------------------------------------------
DL_TOOL=""
detect_downloader() {
  if command -v curl >/dev/null 2>&1; then
    DL_TOOL="curl"
  elif command -v wget >/dev/null 2>&1; then
    DL_TOOL="wget"
  else
    die "neither curl nor wget found. Install one, or use the npm channel:
  npm install -g $PKG_NAME"
  fi
}

# download <url> <dest-file>
download() {
  url="$1"
  dest="$2"
  if [ "$DL_TOOL" = "curl" ]; then
    curl -fSL --retry 3 -o "$dest" "$url" || die "download failed: $url"
  else
    wget -q -O "$dest" "$url" || die "download failed: $url"
  fi
}

# ---------------------------------------------------------------------------
# sha256 — fail closed if no tool is available.
# ---------------------------------------------------------------------------
sha256_of() {
  file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  else
    die "no sha256 tool (sha256sum/shasum) found — cannot verify downloads. Aborting."
  fi
}

# verify_sha256 <file> <expected-hex>
verify_sha256() {
  file="$1"
  expected="$2"
  [ -n "$expected" ] || die "empty expected checksum — refusing to trust $file"
  actual="$(sha256_of "$file")"
  if [ "$actual" != "$expected" ]; then
    die "checksum mismatch for $(basename "$file")
  expected: $expected
  actual:   $actual"
  fi
}

# ---------------------------------------------------------------------------
# Platform detection
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
      die "Windows is not supported by this installer. Use the npm channel:
  npm install -g $PKG_NAME"
      ;;
    *)
      die "unsupported OS: $uname_s. Use the npm channel:
  npm install -g $PKG_NAME"
      ;;
  esac

  case "$uname_m" in
    x86_64 | amd64) ARCH="x64" ;;
    arm64 | aarch64) ARCH="arm64" ;;
    armv7* | armv6*)
      die "32-bit ARM ($uname_m) is not supported. Try Docker, or the npm channel:
  npm install -g $PKG_NAME"
      ;;
    riscv*)
      die "RISC-V ($uname_m) is not supported. Try Docker, or the npm channel:
  npm install -g $PKG_NAME"
      ;;
    *)
      die "unsupported CPU architecture: $uname_m. Try Docker, or the npm channel:
  npm install -g $PKG_NAME"
      ;;
  esac

  if [ "$OS" = "linux" ]; then
    check_linux_libc
  fi
}

# musl / Alpine and old-glibc bail — the pinned runtime and native components
# are built against modern glibc.
check_linux_libc() {
  if [ -f /etc/alpine-release ]; then
    die "Alpine / musl libc is not supported by the prebuilt runtime.
Use Docker (glibc-based image) or the npm channel:
  npm install -g $PKG_NAME"
  fi

  # ldd --version prints the libc flavor + version to stdout or stderr.
  ldd_out=""
  if command -v ldd >/dev/null 2>&1; then
    ldd_out="$(ldd --version 2>&1 || true)"
  fi

  case "$ldd_out" in
    *musl*)
      die "musl libc detected. Use Docker (glibc-based image) or the npm channel:
  npm install -g $PKG_NAME"
      ;;
  esac

  # Require glibc >= 2.28 (the runtime's build baseline).
  glibc_line="$(printf '%s\n' "$ldd_out" | head -n 1)"
  glibc_ver="$(printf '%s\n' "$glibc_line" | grep -oE '[0-9]+\.[0-9]+' | head -n 1)"
  if [ -n "$glibc_ver" ]; then
    glibc_major="${glibc_ver%%.*}"
    glibc_minor="${glibc_ver#*.}"
    if [ "$glibc_major" -lt 2 ] || { [ "$glibc_major" -eq 2 ] && [ "$glibc_minor" -lt 28 ]; }; then
      die "glibc $glibc_ver is too old (need >= 2.28). Use Docker or the npm channel:
  npm install -g $PKG_NAME"
    fi
  fi
}

# ---------------------------------------------------------------------------
# Runtime install — download pinned tarball, verify against SHASUMS256.txt,
# unpack under $RUNTIME_DIR.
# ---------------------------------------------------------------------------
NODE_BIN=""
NPM_BIN=""
install_runtime() {
  node_pkg="node-$NODE_VERSION-$OS-$ARCH"
  tarball="$node_pkg.tar.gz"
  tar_url="$NODE_DIST_BASE/$NODE_VERSION/$tarball"
  sums_url="$NODE_DIST_BASE/$NODE_VERSION/SHASUMS256.txt"

  # Already installed and correct version? Skip re-download on upgrade re-runs.
  if [ -x "$RUNTIME_DIR/bin/node" ]; then
    have="$("$RUNTIME_DIR/bin/node" --version 2>/dev/null || echo none)"
    if [ "$have" = "$NODE_VERSION" ]; then
      info "Runtime $NODE_VERSION already present — reusing."
      NODE_BIN="$RUNTIME_DIR/bin/node"
      NPM_BIN="$RUNTIME_DIR/bin/npm"
      return 0
    fi
  fi

  step "Downloading the bundled runtime ($node_pkg)"
  download "$tar_url" "$TMP_DIR/$tarball"

  step "Verifying runtime checksum (fail-closed)"
  download "$sums_url" "$TMP_DIR/SHASUMS256.txt"
  expected="$(grep " $tarball\$" "$TMP_DIR/SHASUMS256.txt" | awk '{print $1}')"
  [ -n "$expected" ] || die "no checksum entry for $tarball in SHASUMS256.txt"
  verify_sha256 "$TMP_DIR/$tarball" "$expected"
  info "Checksum OK."

  step "Unpacking the runtime into $RUNTIME_DIR"
  rm -rf "$RUNTIME_DIR"
  mkdir -p "$RUNTIME_DIR"
  # Strip the top-level node-<ver>-<os>-<arch>/ directory.
  tar -xzf "$TMP_DIR/$tarball" -C "$RUNTIME_DIR" --strip-components=1

  NODE_BIN="$RUNTIME_DIR/bin/node"
  NPM_BIN="$RUNTIME_DIR/bin/npm"
  [ -x "$NODE_BIN" ] || die "runtime unpack failed — $NODE_BIN missing"
}

# ---------------------------------------------------------------------------
# Tool install — use the PINNED runtime's own package manager so any native
# components resolve prebuilds for the correct runtime, into $TOOL_DIR.
# ---------------------------------------------------------------------------
install_tool() {
  mkdir -p "$TOOL_DIR"

  spec="$PKG_NAME"
  if [ -n "${WIGOLO_INSTALL_SOURCE:-}" ]; then
    [ -f "$WIGOLO_INSTALL_SOURCE" ] || die "WIGOLO_INSTALL_SOURCE not found: $WIGOLO_INSTALL_SOURCE"
    spec="$WIGOLO_INSTALL_SOURCE"
    step "Installing wigolo from local package: $spec"
  else
    step "Installing wigolo from the registry"
  fi

  # PATH so the runtime's node is what npm and node-gyp see.
  NPM_CONFIG_PREFIX="$TOOL_DIR" \
    PATH="$RUNTIME_DIR/bin:$PATH" \
    "$NPM_BIN" install -g --no-fund --no-audit "$spec" >&2 \
    || die "tool install failed"
}

# ---------------------------------------------------------------------------
# Prebuilt binary path (canonical when a release ships one). Returns 0 if a
# binary was installed, 1 if none is available for this platform.
# ---------------------------------------------------------------------------
try_prebuilt_binary() {
  # Skip entirely when installing from a local tarball (test / dev path).
  [ -z "${WIGOLO_INSTALL_SOURCE:-}" ] || return 1

  bin_name="wigolo-$OS-$ARCH"
  bin_url="$BIN_RELEASE_BASE/$bin_name"
  sums_url="$BIN_RELEASE_BASE/checksums.txt"

  # Probe the checksums file first; absence => no binary channel yet.
  if [ "$DL_TOOL" = "curl" ]; then
    curl -fsSL --retry 2 -o "$TMP_DIR/checksums.txt" "$sums_url" 2>/dev/null || return 1
  else
    wget -q -O "$TMP_DIR/checksums.txt" "$sums_url" 2>/dev/null || return 1
  fi
  expected="$(grep " $bin_name\$" "$TMP_DIR/checksums.txt" | awk '{print $1}')"
  [ -n "$expected" ] || return 1

  step "Downloading prebuilt binary ($bin_name)"
  download "$bin_url" "$TMP_DIR/$bin_name" || return 1
  step "Verifying binary checksum (fail-closed)"
  verify_sha256 "$TMP_DIR/$bin_name" "$expected"

  mkdir -p "$BIN_DIR"
  mv "$TMP_DIR/$bin_name" "$BIN_DIR/wigolo"
  chmod 0755 "$BIN_DIR/wigolo"
  info "Installed prebuilt binary to $BIN_DIR/wigolo"
  return 0
}

# ---------------------------------------------------------------------------
# Shim — prepend the runtime's bin to PATH so the CLI's own tooling probes
# (e.g. resolving a package runner for the browser engine) work, then exec the
# installed CLI.
# ---------------------------------------------------------------------------
write_shim() {
  mkdir -p "$BIN_DIR"
  entry="$TOOL_DIR/lib/node_modules/$PKG_NAME/dist/index.js"
  [ -f "$entry" ] || die "CLI entry not found at $entry after install"

  cat > "$BIN_DIR/wigolo" <<EOF
#!/bin/sh
# wigolo launcher (generated by install.sh). Prepends the bundled runtime so
# the CLI's package-runner probes resolve, then runs the installed CLI.
export PATH="$RUNTIME_DIR/bin:\$PATH"
exec "$RUNTIME_DIR/bin/node" "$TOOL_DIR/lib/node_modules/$PKG_NAME/dist/index.js" "\$@"
EOF
  chmod 0755 "$BIN_DIR/wigolo"
}

# ---------------------------------------------------------------------------
# Uninstall — remove the tool, but PRESERVE user data (cache/models/keys).
# ---------------------------------------------------------------------------
do_uninstall() {
  step "Removing the wigolo tool (preserving your data in $PREFIX)"
  rm -rf "$BIN_DIR" "$TOOL_DIR" "$RUNTIME_DIR"
  info "Removed: $BIN_DIR, $TOOL_DIR, $RUNTIME_DIR"
  info "Preserved: your cache, models, and keys under $PREFIX"
  info ""
  info "To wipe everything including data:  rm -rf $PREFIX"
  exit 0
}

# ---------------------------------------------------------------------------
# Closing message + doctor verdict.
# ---------------------------------------------------------------------------
finish() {
  step "Verifying the install"
  if "$BIN_DIR/wigolo" doctor >&2; then
    doctor_ok=1
  else
    doctor_ok=0
  fi

  info ""
  info "wigolo installed to $BIN_DIR/wigolo"
  info ""
  info "Add to your shell (so 'wigolo' resolves in your terminal):"
  info "  export PATH=\"$BIN_DIR:\$PATH\""
  info ""
  info "Wire it into your AI agent (use the ABSOLUTE path — MCP clients do not"
  info "read your shell PATH):"
  info "  claude mcp add wigolo -- $BIN_DIR/wigolo"
  info ""
  if [ "$doctor_ok" -eq 1 ]; then
    info "Health check: OK."
  else
    info "Health check reported issues above — run '$BIN_DIR/wigolo doctor' for detail."
  fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
  for arg in "$@"; do
    case "$arg" in
      --uninstall)
        do_uninstall
        ;;
      -h | --help)
        info "wigolo installer"
        info "  (no args)     install or upgrade wigolo under $PREFIX"
        info "  --uninstall   remove the tool, preserving your cache/models/keys"
        exit 0
        ;;
      *)
        die "unknown argument: $arg (try --help)"
        ;;
    esac
  done

  detect_downloader
  detect_platform

  mkdir -p "$PREFIX" "$BIN_DIR"
  TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/wigolo-install.XXXXXX")"

  step "Installing wigolo for $OS/$ARCH into $PREFIX"

  if try_prebuilt_binary; then
    info "Using prebuilt binary."
  else
    install_runtime
    install_tool
    write_shim
  fi

  finish
}

main "$@"
