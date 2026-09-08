#!/bin/sh
# The consumer's battery against an installed wigolo — single-binary mini-spec §4 (BIN-8).
#
#   consumer-smoke.sh <path-to-bin/wigolo> <expected-semver>
#
# WHY THIS IS A SHELL SCRIPT AND NOT A NODE ONE. It is the whole point of this smoke that
# no interpreter is on PATH when it runs. `scripts/binary/verify.mjs` asks the same kind of
# questions from inside the build, with the build's own Node answering them; this file asks
# them from where a user stands, with nothing installed but the artifact. A battery that
# needed Node would be measuring the runner, not the download.
#
# WHY EVERY FAILURE NAMES A GUARANTEE. §4's five guarantees are the contract; "the smoke is
# red" is not an answer anyone can act on. Each arm below fails with the guarantee it broke,
# so a red release job says which promise stopped being true rather than which line ran.
#
# THE ONE TOLERATED REFUSAL. PX brief §0a.1 (2026-09-03) makes the registration gate
# Studio-only: "core CLI/MCP runs unregistered". The tip does not do that yet — `fetch` and
# `cache` are still walled by the PX2 activation gate, which is the known-red class owned by
# wigolo-studio-run#336. So the two tool arms accept EXACTLY that refusal line and nothing
# else, count it, and end the run with a warning naming the issue. Any other failure of
# those arms is red, and once #336 lands the tolerated branch stops being taken — at which
# point the arms are hard assertions with no edit to this file.

set -eu

EXE="${1:-}"
WANT_SEMVER="${2:-}"

[ -n "$EXE" ] && [ -n "$WANT_SEMVER" ] || {
  printf 'usage: consumer-smoke.sh <path-to-bin/wigolo> <expected-semver>\n' >&2
  exit 2
}

FAILURES=0
DEFERRED=0

# The exact refusal `src/cli/tool-run.ts` prints when the activation gate walls a tool
# command. Matched as a fixed substring, not a pattern: a wider match would swallow the
# next refusal someone adds and call it a known red.
GATE_LINE='wigolo needs an account'

pass() { printf '  ok   %s — %s\n' "$1" "$2" >&2; }

# fail <guarantee-id> <guarantee-name> <what-broke>
fail() {
  FAILURES=$((FAILURES + 1))
  printf '  FAIL %s (%s) broke: %s\n' "$1" "$2" "$3" >&2
  printf '::error::guarantee %s (%s) broke: %s\n' "$1" "$2" "$3"
}

defer() {
  DEFERRED=$((DEFERRED + 1))
  printf '  gate %s — refused by the activation gate, not run (#336)\n' "$1" >&2
}

# resolve_exe <path> — the path with every symlink in its final component resolved.
#
# WHY THIS EXISTS. Both real acquisition paths hand this script a SYMLINK, not the executable:
# install.sh links `~/.local/bin/wigolo` at an absolute path inside `~/.wigolo/dist/...`, and
# brew links `<prefix>/bin/wigolo` at a relative path inside the keg. Deriving the installed
# tree from `dirname` of the link gives `~/.local` or `<brew prefix>` — the link's directory,
# not the artifact's — and the G1 arm below then copies the wrong tree. On the install.sh leg
# that copy still ran, because the copied absolute symlink pointed back at the untouched
# original: the arm re-ran the binary from its original location and called that relocation.
# `pwd -P` on the resolved path is what makes G1 an assertion instead of a tautology.
#
# `readlink` without `-f`: BSD readlink and GNU readlink agree on the one-hop form, and the
# loop is the portable way to reach the end of a chain.
resolve_exe() {
  p="$1"
  n=0
  while [ -L "$p" ]; do
    n=$((n + 1))
    [ "$n" -lt 40 ] || { printf '%s\n' "$1"; return 0; }
    t="$(readlink "$p")"
    case "$t" in
      /*) p="$t" ;;
      *) p="$(dirname "$p")/$t" ;;
    esac
  done
  printf '%s/%s\n' "$(cd "$(dirname "$p")" && pwd -P)" "$(basename "$p")"
}

# run_capture <outfile> <cmd...> — never lets a non-zero child kill the script.
run_capture() {
  out="$1"
  shift
  set +e
  "$@" >"$out" 2>&1
  rc=$?
  set -e
  return $rc
}

printf '\n== consumer smoke: %s (expecting %s) ==\n' "$EXE" "$WANT_SEMVER" >&2

TMP="$(mktemp -d "${TMPDIR:-/tmp}/wigolo-smoke.XXXXXX")"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------------------
# G5 — versioned. The VERSION file inside the archive is what install.sh checked; this is
# the executable's own answer, which is the one a user ever sees.
# ---------------------------------------------------------------------------
# `wigolo --version` answers `wigolo <semver>`, so the version is the last field rather than
# the whole line. Reported back in full on a mismatch — "says '0.0.1'" is actionable, "says
# 'wigolo0.0.1'" is a bug report about this file.
reported_semver() { awk 'NR == 1 { print $NF }' "$1"; }

if run_capture "$TMP/version.txt" "$EXE" --version; then
  got="$(reported_semver "$TMP/version.txt")"
  if [ "$got" = "$WANT_SEMVER" ]; then
    pass G5 "--version says $got"
  else
    fail G5 versioned "\`wigolo --version\` printed '$(head -n 1 "$TMP/version.txt")', the release published $WANT_SEMVER"
  fi
else
  fail G5 versioned "\`wigolo --version\` exited non-zero: $(head -c 400 "$TMP/version.txt")"
fi

# ---------------------------------------------------------------------------
# G1 — relocatable. Copy the whole installed tree somewhere with a different depth and a
# space in its name, and run it from there. `bin/wigolo` has to find `libexec/` from its
# own realpath; a baked absolute path passes at the original location and only at it.
# ---------------------------------------------------------------------------
ROOT="$(cd "$(dirname "$(resolve_exe "$EXE")")/.." && pwd -P)"
RELOC="$TMP/a moved/place"
mkdir -p "$RELOC"
cp -R "$ROOT" "$RELOC/wigolo"
if run_capture "$TMP/reloc.txt" "$RELOC/wigolo/bin/wigolo" --version; then
  got="$(reported_semver "$TMP/reloc.txt")"
  if [ "$got" = "$WANT_SEMVER" ]; then
    pass G1 "runs from a relocated copy under a path with a space"
  else
    fail G1 relocatable "the relocated copy printed '$(head -n 1 "$TMP/reloc.txt")', not $WANT_SEMVER"
  fi
else
  fail G1 relocatable "the relocated copy would not start: $(head -c 400 "$TMP/reloc.txt")"
fi

# ---------------------------------------------------------------------------
# The run surface — MCP stdio. Not a §4 guarantee by number, but §4's own description of
# what `bin/wigolo` IS ("CLI + MCP stdio + daemon + REPL + companion-broker"), and the one
# an agent client actually depends on. `initialize` and `tools/list` are not gated.
#
# The fifo is how a POSIX shell holds stdin open across a request/response pair: the server
# exits on EOF, so writing all three lines and closing immediately would race the reply.
# ---------------------------------------------------------------------------
mkfifo "$TMP/mcp-in"
WIGOLO_DATA_DIR="$TMP/data-mcp" "$EXE" mcp <"$TMP/mcp-in" >"$TMP/mcp-out" 2>"$TMP/mcp-err" &
MCP_PID=$!
exec 9>"$TMP/mcp-in"

# Writing to a server that has already died raises SIGPIPE, and a SIGPIPE here would take
# the whole battery down at the point where it is about to REPORT the death.
send() { printf '%s\n' "$1" >&9 2>/dev/null || true; }

# Wait for a reply, but stop the moment the server is gone: a dead child would otherwise be
# indistinguishable from a slow one until the timeout, and a red release job that takes two
# extra minutes to say so is a red release job nobody reads to the end.
await() {
  waited=0
  while [ "$waited" -lt 45 ]; do
    if grep -q "$1" "$TMP/mcp-out" 2>/dev/null; then return 0; fi
    if ! kill -0 "$MCP_PID" 2>/dev/null; then return 1; fi
    sleep 1
    waited=$((waited + 1))
  done
  return 1
}

send '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"consumer-smoke","version":"0"}}}'
set +e
await '"serverInfo"'
send '{"jsonrpc":"2.0","method":"notifications/initialized"}'
send '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
await '"tools"'
set -e
exec 9>&-
set +e
kill "$MCP_PID" 2>/dev/null
wait "$MCP_PID" 2>/dev/null
set -e

if grep -q '"serverInfo"' "$TMP/mcp-out" 2>/dev/null && grep -q '"tools"' "$TMP/mcp-out" 2>/dev/null; then
  # Every stdout line must be JSON-RPC. A banner or a stray log on stdout corrupts the
  # transport for every client, and is invisible to a test that only greps for a key.
  if grep -qv '^{"' "$TMP/mcp-out"; then
    fail RUN "MCP stdio" "stdout carried a line that is not JSON-RPC: $(grep -m1 -v '^{"' "$TMP/mcp-out" | head -c 200)"
  elif grep -q "\"version\":\"$WANT_SEMVER\"" "$TMP/mcp-out"; then
    pass RUN "MCP handshake answered, stdout byte-clean, serverInfo says $WANT_SEMVER"
  else
    fail RUN "MCP stdio" "serverInfo did not report version $WANT_SEMVER"
  fi
else
  fail RUN "MCP stdio" "no handshake in $(wc -c <"$TMP/mcp-out" | tr -d ' ') stdout bytes; stderr: $(head -c 400 "$TMP/mcp-err")"
fi

# ---------------------------------------------------------------------------
# One fetch and one cache op, from the artifact alone. See THE ONE TOLERATED REFUSAL above.
# ---------------------------------------------------------------------------
DATA="$TMP/data-ops"
FETCH_URL="${WIGOLO_SMOKE_FETCH_URL:-https://example.com}"

if run_capture "$TMP/fetch.txt" env WIGOLO_DATA_DIR="$DATA" "$EXE" fetch "$FETCH_URL"; then
  if [ -s "$TMP/fetch.txt" ]; then
    pass OPS "fetch $FETCH_URL returned $(wc -c <"$TMP/fetch.txt" | tr -d ' ') bytes"
  else
    fail OPS "run surface" "\`wigolo fetch\` exited 0 and printed nothing"
  fi
elif grep -qF "$GATE_LINE" "$TMP/fetch.txt"; then
  defer fetch
else
  fail OPS "run surface" "\`wigolo fetch $FETCH_URL\` failed: $(head -c 400 "$TMP/fetch.txt")"
fi

if run_capture "$TMP/cache.txt" env WIGOLO_DATA_DIR="$DATA" "$EXE" cache stats; then
  pass OPS "cache stats answered from the artifact's own database"
elif grep -qF "$GATE_LINE" "$TMP/cache.txt"; then
  defer "cache stats"
else
  fail OPS "run surface" "\`wigolo cache stats\` failed: $(head -c 400 "$TMP/cache.txt")"
fi

# ---------------------------------------------------------------------------
# G2 — offline-first. Linux only, and required there rather than best-effort: `unshare -rn`
# gives the process a network namespace with nothing but loopback, so a binary that reaches
# for the network before it can answer `--version` cannot pass by being fast or by being run
# on a runner that happened to have connectivity. macOS and Windows have no unprivileged
# equivalent, which is why this arm has a platform and says so instead of being skipped
# quietly on all three.
# ---------------------------------------------------------------------------
if [ "$(uname -s)" = "Linux" ]; then
  # Two ways in, because neither is available everywhere. `unshare -rn` needs unprivileged
  # user namespaces, which Ubuntu 24.04 (and the GitHub image built on it) restricts by
  # AppArmor — it fails with `write failed /proc/self/uid_map: Operation not permitted`, a
  # refusal from the sandbox rather than from the artifact. `sudo unshare -n` needs a
  # passwordless sudo, which a CI runner has and a developer's laptop may not. The sudo runs
  # BEFORE the namespace exists, so it is not itself inside the network cut.
  OFFLINE_HOME="$TMP/offline-home"
  mkdir -p "$OFFLINE_HOME"
  if sudo -n true 2>/dev/null; then
    set -- sudo -n unshare -n env HOME="$OFFLINE_HOME" "$EXE" --version
  else
    set -- unshare -rn env HOME="$OFFLINE_HOME" "$EXE" --version
  fi

  if run_capture "$TMP/offline.txt" "$@"; then
    got="$(reported_semver "$TMP/offline.txt")"
    if [ "$got" = "$WANT_SEMVER" ]; then
      pass G2 "answers with no network namespace at all"
    else
      fail G2 "offline-first" "with no network it printed '$(head -n 1 "$TMP/offline.txt")', not $WANT_SEMVER"
    fi
  else
    fail G2 "offline-first" "with no network it would not start: $(head -c 400 "$TMP/offline.txt")"
  fi
else
  printf '  n/a  G2 — no unprivileged network-namespace equivalent on %s; the linux leg carries this arm\n' "$(uname -s)" >&2
fi

# ---------------------------------------------------------------------------
printf '\n' >&2
if [ "$DEFERRED" -gt 0 ]; then
  printf '::warning::%s tool arm(s) were refused by the activation gate rather than run. PX brief §0a.1 makes the gate Studio-only and the core CLI unregistered; the tip does not yet, which is wigolo-studio-run#336.\n' "$DEFERRED"
fi
if [ "$FAILURES" -gt 0 ]; then
  printf '%s guarantee(s) broke.\n' "$FAILURES" >&2
  exit 1
fi
printf 'consumer smoke green (%s deferred).\n' "$DEFERRED" >&2
