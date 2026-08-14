/*
 * Drop the non-host native binaries `wreq-js` ships to everyone.
 *
 * WHY THIS EXISTS. `wreq-js@2.3.1` is the largest package left in the production tree — 54 MiB
 * measured on darwin-arm64 — and 53.3 MiB of that is `rust/wreq-js.<target>.node`, seven
 * prebuilt napi binaries of which at most one can ever be loaded. On darwin-arm64 the host
 * binary is 6.9 MiB, so ~46 MiB is shipped to every user to be read by nobody.
 *
 * WHY IT CANNOT BE FIXED IN THE MANIFEST. Four things were checked before writing any code:
 *
 *  1. `wreq-js` publishes NO platform-scoped subpackages. `sharp` shows the arrangement that
 *     WOULD work — per-platform optionalDependencies each carrying its own `os`/`cpu`, of which
 *     a host installs the two that match — but wreq-js has not made that packaging decision.
 *     `@wreq-js/darwin-arm64` and `wreq-js-darwin-arm64` are both 404 on the registry, at every
 *     naming convention napi-rs uses. There is nothing to depend on selectively.
 *  2. Its `files` field is `["dist", "rust/*.node"]`, so all seven binaries are in the ONE
 *     tarball. npm's `dist.unpackedSize` is 56.5 MB for 2.3.1 and 59.8 MB for 3.0.0 across 15
 *     files, i.e. the newest release has not changed the arrangement either.
 *  3. It declares `os: ["darwin","linux","win32"]` and `cpu: ["x64","arm64"]`. npm's os/cpu
 *     filtering is per-PACKAGE, and a package declaring every platform it supports installs in
 *     full on all of them. The fields are the union; they never exclude anything.
 *  4. It is ALREADY in `optionalDependencies`, and that does not remove a byte — npm installs
 *     optional dependencies, it just tolerates their failure. The peer/optional pair that moved
 *     the browser driver off the default install path (1eb4e4cf) is the manifest lever that
 *     works, and it is the wrong lever here: the TLS-impersonation tier is the anti-bot
 *     capability users churn over, and making it a post-install acquisition would disable it out
 *     of the box for every user to save 8 MiB more than this prune does.
 *
 * Selection is therefore a pure runtime concern, and the loader (`dist/wreq-js.cjs`) does it
 * with a hardcoded per-target chain — for each `platform`/`arch`/`libc` it tries exactly one
 * named file and then `../rust/wreq-js.node`. Nothing enumerates the directory, so a sibling
 * that is absent is a sibling nothing looks for.
 *
 * ⚠ WHY LINUX KEEPS BOTH LIBC BUILDS. The loader's `detectLibc()` reads
 * `process.env.LIBC ?? process.env.npm_config_libc` before it looks at anything else, and
 * `npm_config_libc` is set by npm during an install and absent at runtime. Install-time and
 * run-time detection can therefore disagree on one machine, and this script runs at install
 * time. Keeping both gnu and musl for the host arch removes that entire class instead of
 * predicting it, at a cost of ~8 MiB on linux only. darwin and win32 have no libc dimension and
 * keep exactly one file.
 *
 * ⚠ AND WHY REMOVAL IS ALLOWLISTED. Unlike onnxruntime-node — whose directories are literally
 * `${process.platform}/${process.arch}`, so "not the host pair" is provably unloadable — these
 * are napi triple names that no interpolation of `process.*` produces (`win32-x64-msvc`, plus a
 * libc suffix). Anything not on the seven-name list the loader itself enumerates is left alone:
 * that covers the generic `wreq-js.node` fallback the loader tries second, and any target a
 * future release adds. Leaving an unknown file costs bytes; deleting the one the loader wanted
 * costs the user their anti-bot tier.
 *
 * WHAT THIS COSTS. The pruned tree is bound to the platform and architecture that installed it —
 * a property the tree already had, via `better-sqlite3`, `sharp` and the onnxruntime prune that
 * precedes this one. `WIGOLO_SKIP_ORT_PRUNE=1` skips every prune in this directory, including
 * this one, for anyone deliberately building a multi-arch tree.
 *
 * FAIL-OPEN, ALWAYS. If no binary the host could load is present the planner refuses to remove
 * anything at all, because a tree we cannot prove has a usable binary is a tree we must not
 * touch. If a removal throws it is reported and skipped. The driver never exits non-zero.
 */

/**
 * Every target `wreq-js@2.3.1` ships, matching the manifest's `napi.targets` and the loader's
 * own hardcoded require chain. This is an ALLOWLIST of what may be removed, never a pattern.
 */
export const WREQ_PLATFORM_BINARIES = Object.freeze([
  'wreq-js.darwin-arm64.node',
  'wreq-js.darwin-x64.node',
  'wreq-js.linux-arm64-gnu.node',
  'wreq-js.linux-arm64-musl.node',
  'wreq-js.linux-x64-gnu.node',
  'wreq-js.linux-x64-musl.node',
  'wreq-js.win32-x64-msvc.node',
]);

/**
 * The binaries `platform`/`arch` could ever load, in the loader's own spelling.
 *
 * Linux maps to BOTH libc builds on purpose — see the note above. An unsupported host maps to
 * the empty list, which is what drives the planner's refusal.
 */
function hostCandidates(platform, arch) {
  if (platform === 'darwin' && (arch === 'x64' || arch === 'arm64')) return [`wreq-js.darwin-${arch}.node`];
  if (platform === 'win32' && arch === 'x64') return ['wreq-js.win32-x64-msvc.node'];
  if (platform === 'linux' && (arch === 'x64' || arch === 'arm64')) {
    return [`wreq-js.linux-${arch}-gnu.node`, `wreq-js.linux-${arch}-musl.node`];
  }
  return [];
}

/**
 * Decide which `rust/wreq-js.*.node` files may be removed.
 *
 * Pure, and separate from the filesystem on purpose — this is the part with a decision in it, so
 * it is the part that has to be testable without an npm install to run it against.
 *
 * @param present  {string[]} basenames found in the package's `rust/` directory
 * @param platform host `process.platform`
 * @param arch     host `process.arch`
 * @returns {{ keep: string[], remove: string[], reason: string }}
 */
export function planBinaryPrune(present, platform, arch) {
  const have = new Set(present);
  const keep = hostCandidates(platform, arch).filter((f) => have.has(f));

  // ⚠ The refusal, and the reason it is first. With nothing loadable identified we cannot tell
  // "already pruned past recognition" from "this package is laid out differently than we
  // believe", and in the second case every candidate for removal might be the one that loads.
  if (keep.length === 0) {
    return {
      keep: [],
      remove: [],
      reason: `no loadable binary identified for ${platform}/${arch} — refusing to prune`,
    };
  }

  const kept = new Set(keep);
  const remove = present.filter((f) => WREQ_PLATFORM_BINARIES.includes(f) && !kept.has(f)).sort();

  return {
    keep,
    remove,
    reason: remove.length
      ? `keeping ${keep.join(' + ')}, removing ${remove.length} non-host binary(ies)`
      : `only ${keep.join(' + ')} present — nothing to do`,
  };
}
