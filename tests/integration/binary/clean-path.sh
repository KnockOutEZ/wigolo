#!/bin/sh
# Print a PATH with no interpreter on it, and refuse if that is not what it managed —
# single-binary mini-spec §4 (BIN-8).
#
#   clean-path.sh [base-PATH]
#
# WHY IT IS A SCRIPT AND NOT A `GITHUB_ENV` LINE. A stripped PATH exported once and inherited
# by later steps is a claim those steps cannot check: if the export silently did not take,
# every one of them runs with a Node on PATH and the job stays green. So each step that must
# be clean calls this, in its own process, and the refusal lives inside the thing being used.
#
# WHY IT STARTS FROM THE SYSTEM DIRECTORIES RATHER THAN FROM `$PATH`. Subtracting from the
# runner's PATH keeps whatever else the image put there; starting from the system list keeps
# only what a machine that has never installed anything would have. The base is an argument
# so the pruning and the refusal can be forced in a test with a directory built to trip them.
#
# WHY THE ESSENTIAL TOOLS ARE CHECKED AFTER PRUNING. Pruning is blind — it removes whatever
# directory an interpreter resolved from, and on some machine that directory is also the one
# holding `curl`. A PATH that no longer has the installer's own tools would fail later, in
# `install.sh`, reading as a download problem. Refusing here names the real cause.

set -u

CLEAN="${1:-/usr/bin:/bin:/usr/sbin:/sbin}"

for tool in node npm npx; do
  while resolved="$(PATH="$CLEAN" command -v "$tool" 2>/dev/null)"; do
    dir="$(dirname "$resolved")"
    printf 'pruning %s (it holds %s)\n' "$dir" "$tool" >&2
    CLEAN="$(printf '%s' "$CLEAN" | tr ':' '\n' | grep -vx "$dir" | paste -sd: -)"
  done
done

# The installer's own toolbox has to have survived. `sh` is not in the list: it is what runs
# this file, so its absence is not a state this can reach.
for tool in curl tar awk sed grep uname mktemp ln; do
  if ! PATH="$CLEAN" command -v "$tool" >/dev/null 2>&1; then
    printf '::error::stripping the interpreters also took %s off PATH, which install.sh needs\n' "$tool"
    exit 1
  fi
done

# The probe the acceptance criterion asks for: this must FAIL.
if PATH="$CLEAN" node --version >/dev/null 2>&1; then
  printf '::error::node --version answered under the stripped PATH — this smoke would not be testing a clean machine\n'
  exit 1
fi
printf 'node --version failed under PATH=%s, as required.\n' "$CLEAN" >&2

printf '%s' "$CLEAN"
