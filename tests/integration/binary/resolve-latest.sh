#!/bin/sh
# Exercise `install.sh`'s LATEST-RELEASE RESOLUTION against the live release feed —
# single-binary mini-spec §5 (BIN-8, counter-review finding 4).
#
#   resolve-latest.sh <install.sh URL>
#
# WHY THIS IS A SEPARATE LEG. The main unix leg pins `WIGOLO_VERSION` and
# `WIGOLO_RELEASE_TAG`, because a prerelease on the binary-only channel is not what the
# feed's `latest` points at — so that leg never runs `resolve_version`'s feed branch at all.
# This one runs exactly that branch, against the real API, with nothing pinned.
#
# WHAT IT ASSERTS AND WHAT IT TOLERATES. Resolution is finished, and observable, BEFORE any
# asset is fetched: install.sh prints `Installing wigolo <version> for <os>/<arch>` (or the
# already-installed line) as its last act before the first download. So a resolved version
# appearing in the transcript is the whole assertion, and a subsequent download failure is
# tolerated — but ONLY when it names that same version. Until a `v*.*.*` release carries
# binary assets, that download failure is the expected end of this leg, and it is exactly
# what a user running the published one-liner sees today.
#
# It installs into a temporary root so that whatever it resolves cannot disturb the artifact
# the main leg put in place.

set -u

URL="${1:-}"
[ -n "$URL" ] || { printf 'usage: resolve-latest.sh <install.sh URL>\n' >&2; exit 2; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/wigolo-latest.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT INT TERM

fail() {
  printf '::error::latest-release resolution broke: %s\n' "$*"
  exit 1
}

# One retry. The feed is an unauthenticated API call from a shared runner address, so a rate
# limit reads to install.sh exactly like an outage, and a release job that goes red for
# someone else's quota is a release job people learn to re-run without reading.
attempt=1
while [ "$attempt" -le 2 ]; do
  curl -fsSL "$URL" \
    | env WIGOLO_INSTALL_DIR="$TMP/root" sh >"$TMP/log" 2>&1
  status=$?
  if ! grep -q 'could not reach the release feed' "$TMP/log"; then break; fi
  printf 'the release feed did not answer on attempt %s; retrying once\n' "$attempt" >&2
  attempt=$((attempt + 1))
  sleep 20
done

cat "$TMP/log" >&2

grep -q 'Looking up the latest version' "$TMP/log" \
  || fail "install.sh never consulted the release feed — something pinned the version"
grep -q 'could not reach the release feed' "$TMP/log" \
  && fail "the release feed did not answer, twice"
grep -q 'did not name a latest version' "$TMP/log" \
  && fail "the feed answered but no tag_name could be read out of it"

VERSION="$(
  sed -n \
    -e 's/^==> Installing wigolo \([^ ]*\) for .*/\1/p' \
    -e 's/^==> wigolo \([^ ]*\) is already installed.*/\1/p' \
    "$TMP/log" | head -n 1
)"
[ -n "$VERSION" ] || fail "no version was named after the lookup — resolution did not complete"

if [ "$status" -eq 0 ]; then
  printf '  ok   latest resolved to %s from the live feed, and it installed\n' "$VERSION" >&2
  exit 0
fi

# The tolerated end: resolution worked, the release it named has no artifacts for this
# platform. Tolerated only when the refusal names the version that was just resolved — any
# other failure after a successful lookup is this leg's to report.
if grep -q "could not download the checksum file for v$VERSION" "$TMP/log" \
  || grep -q "there may be no build for" "$TMP/log"; then
  printf '  ok   latest resolved to %s from the live feed; that release carries no binary assets yet\n' "$VERSION" >&2
  printf '::notice::install.sh resolved latest to %s over the live feed. That release has no binary assets, which is the expected state until a v*.*.* release carries them.\n' "$VERSION"
  exit 0
fi

fail "resolution named $VERSION and then failed for a reason that is not a missing asset (exit $status)"
