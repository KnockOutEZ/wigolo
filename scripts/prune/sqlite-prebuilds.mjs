/*
 * Drop the non-host `better-sqlite3` prebuilds.
 *
 * WHY THIS EXISTS, AND WHY IT DID NOT BEFORE. `better-sqlite3` used to be a source build:
 * `~12.9.0` compiled through node-gyp (or fetched ONE prebuild via prebuild-install) and left a
 * single `build/Release/better_sqlite3.node`, ~1.8 MiB, with nothing foreign to remove. v13 moved
 * to Node-API prebuilds and ships ALL EIGHT targets in the one tarball — 16 MiB of `prebuilds/`,
 * of which at most one (two on linux, see below) can ever be loaded. That is the trade v13 makes:
 * the all-platforms tarball is exactly what makes it ABI-portable across Node and the desktop
 * shell without a rebuild step, and exactly what makes it fat per-platform.
 *
 * WHY IT CANNOT BE FIXED IN THE MANIFEST. `better-sqlite3` publishes no platform-scoped
 * subpackages — there is no `@better-sqlite3/darwin-arm64` to depend on selectively, the way
 * `sharp` arranges it. Its `files` field ships `prebuilds/` whole, and it declares no `os`/`cpu`
 * narrowing that npm could filter on. The version pin is the only manifest lever and it is the
 * wrong one: v12's single binary is V8-ABI-bound and cannot be loaded by the desktop shell, which
 * is the entire reason the pin moved to v13.
 *
 * SELECTION IS A PURE RUNTIME CONCERN, and the loader (`lib/binding.js`) does it by computing ONE
 * exact filename — `prebuilds/${isLinuxMusl() ? 'linuxmusl' : platform}-${arch}.node` — and
 * `fs.existsSync`ing it. Nothing enumerates the directory, so a sibling that is absent is a
 * sibling nothing looks for.
 *
 * ⚠ WHY THE REFUSAL IS NOT OPTIONAL HERE, and why it matters more than it did for `wreq-js`.
 * When `getPrebuildPath()` finds nothing, the loader does NOT degrade — it falls through to
 * `build/Debug` then `build/Release` and `require`s the latter unconditionally. Under v13 those
 * directories do not exist, so a tree whose host prebuild was removed does not lose a capability,
 * it throws MODULE_NOT_FOUND on the cache database and takes the whole tool down. Removing the
 * wrong file here is therefore not a degradation, it is a broken install, so the planner refuses
 * to remove anything at all unless it has positively identified a prebuild this host can load.
 *
 * ⚠ WHY LINUX KEEPS BOTH LIBC BUILDS. The loader's `isLinuxMusl()` reads
 * `process.report.getReport().header.glibcVersionRuntime` — a genuine runtime probe, which is
 * better than the env-var sniff `wreq-js` uses. But this script still runs at INSTALL time, in a
 * different process from the one that will load the binary, and the two can legitimately disagree
 * (a glibc build stage populating a tree that a musl stage runs, which is an ordinary multi-stage
 * container layout). Keeping both `linux-<arch>` and `linuxmusl-<arch>` removes that entire class
 * instead of predicting it, at a cost of ~2 MiB on linux only. darwin and win32 have no libc
 * dimension and keep exactly one file. Same reasoning, and the same conclusion, as
 * ./wreq-binaries.mjs.
 *
 * ⚠ AND WHY REMOVAL IS ALLOWLISTED. The names are `${platform}-${arch}.node` with a `linuxmusl`
 * special case, so an interpolation of `process.*` very nearly produces them — which is precisely
 * the trap. `linuxmusl` is not a `process.platform` any host reports, so a pattern-based prune
 * that trusted interpolation would delete the musl builds on every glibc machine and the glibc
 * builds on every musl one. Anything not on the eight-name list the package actually ships is left
 * alone: that covers any target a future release adds, whose bytes cost less than its absence.
 *
 * WHAT THIS COSTS. The pruned tree is bound to the platform and architecture that installed it — a
 * property the tree already had, via `sharp`, `wreq-js` and the onnxruntime prune.
 * `WIGOLO_SKIP_ORT_PRUNE=1` skips every prune in this directory, including this one, for anyone
 * deliberately building a multi-arch tree.
 *
 * FAIL-OPEN, ALWAYS. If no prebuild the host could load is present the planner refuses to remove
 * anything. If a removal throws it is reported and skipped. The driver never exits non-zero.
 */

/**
 * Every prebuild `better-sqlite3@13.0.3` ships, matching `prebuilds/` in the published tarball and
 * the targets `lib/binding.js` can compute. This is an ALLOWLIST of what may be removed, never a
 * pattern — see the note above on why interpolation is unsafe for exactly these names.
 */
export const SQLITE_PREBUILDS = Object.freeze([
  'darwin-arm64.node',
  'darwin-x64.node',
  'linux-arm64.node',
  'linux-x64.node',
  'linuxmusl-arm64.node',
  'linuxmusl-x64.node',
  'win32-arm64.node',
  'win32-x64.node',
]);

/**
 * The prebuilds `platform`/`arch` could ever load, in the loader's own spelling.
 *
 * Linux maps to BOTH libc builds on purpose — see the note above. A host outside the loader's own
 * `PREBUILD_PLATFORMS` × `PREBUILD_ARCHS` maps to the empty list, which is what drives the
 * planner's refusal: on such a host the package can only work via a source build, and a tree we
 * cannot prove has a usable prebuild is a tree we must not touch.
 */
function hostCandidates(platform, arch) {
  if (arch !== 'x64' && arch !== 'arm64') return [];
  if (platform === 'darwin' || platform === 'win32') return [`${platform}-${arch}.node`];
  if (platform === 'linux') return [`linux-${arch}.node`, `linuxmusl-${arch}.node`];
  return [];
}

/**
 * Decide which `prebuilds/*.node` files may be removed.
 *
 * Pure, and separate from the filesystem on purpose — this is the part with a decision in it, so
 * it is the part that has to be testable without an npm install to run it against.
 *
 * @param present  {string[]} basenames found in the package's `prebuilds/` directory
 * @param platform host `process.platform`
 * @param arch     host `process.arch`
 * @returns {{ keep: string[], remove: string[], reason: string }}
 */
export function planPrebuildPrune(present, platform, arch) {
  const have = new Set(present);
  const keep = hostCandidates(platform, arch).filter((f) => have.has(f));

  // ⚠ The refusal, and the reason it is first. With nothing loadable identified we cannot tell
  // "already pruned past recognition" from "this package is laid out differently than we believe",
  // and in the second case every candidate for removal might be the one the loader wanted. Unlike
  // the other prunes in this directory, guessing wrong here does not cost bytes or a capability —
  // it throws on `require` and the cache database never opens.
  if (keep.length === 0) {
    return {
      keep: [],
      remove: [],
      reason: `no loadable prebuild identified for ${platform}/${arch} — refusing to prune`,
    };
  }

  const kept = new Set(keep);
  const remove = present.filter((f) => SQLITE_PREBUILDS.includes(f) && !kept.has(f)).sort();

  return {
    keep,
    remove,
    reason: remove.length
      ? `keeping ${keep.join(' + ')}, removing ${remove.length} non-host prebuild(s)`
      : `only ${keep.join(' + ')} present — nothing to do`,
  };
}
