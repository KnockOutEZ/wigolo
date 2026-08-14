/*
 * Drop the non-host platform binaries `onnxruntime-node` ships to everyone.
 *
 * WHY THIS EXISTS. `onnxruntime-node@1.21.0` is the largest package in the production tree —
 * 211.5 MiB of a 683 MiB install measured on darwin-arm64 — and 207.8 MiB of that is
 * `bin/napi-v3/{darwin,linux,win32}/{arm64,x64}`, six prebuilt runtimes of which exactly one
 * can ever be loaded. On darwin-arm64 the host pair is 30.6 MiB, so 177.2 MiB is shipped to
 * every user to be read by nobody.
 *
 * WHY IT CANNOT BE FIXED IN THE MANIFEST. Three things were checked before writing any code:
 *
 *  1. `onnxruntime-node` is a hard `dependencies` entry of BOTH `@huggingface/transformers`
 *     and `fastembed`, each pinning the exact string "1.21.0". There is no range to dedup and
 *     no `overrides` target that removes it.
 *  2. The package declares `os: ["win32","darwin","linux"]` and NO `cpu` field. npm's os/cpu
 *     filtering is per-PACKAGE, not per-directory, so a package that declares all three
 *     platforms installs in full on all three. `sharp` shows the arrangement that WOULD work —
 *     24 platform-scoped optionalDependencies, each with its own `os`/`cpu`, of which this
 *     host installs 2 — but that is upstream's packaging decision and onnxruntime-node has not
 *     made it. There is nothing to gate on from here.
 *  3. Selection is therefore a pure runtime concern, and it is one line
 *     (`onnxruntime-node/dist/binding.js`):
 *
 *         require(`../bin/napi-v3/${process.platform}/${process.arch}/onnxruntime_binding.node`)
 *
 *     That is the ONLY reference to `bin/napi-v3` anywhere in the package's `dist/`. Nothing
 *     enumerates the directory, so a sibling that is absent is a sibling nothing looks for.
 *
 * WHAT THIS COSTS. The pruned tree is bound to the platform and architecture that installed
 * it. That is a property the tree ALREADY had, in two production dependencies, before this
 * script existed: `better-sqlite3` ships a single `build/Release/better_sqlite3.node` chosen
 * by `prebuild-install` at install time, and `sharp` resolves to `@img/sharp-darwin-arm64`
 * via npm's own os/cpu filtering. Both measure as `Mach-O 64-bit ... arm64` on this host. So
 * copying `node_modules` to a different platform, or into a container that differs from the
 * install host, was already broken for wigolo and is not made newly broken here — the failure
 * simply moves from `better_sqlite3.node` to `onnxruntime_binding.node`. The supported fix is
 * the one that was already required: install on the target platform. `WIGOLO_SKIP_ORT_PRUNE=1`
 * is the escape hatch for anyone deliberately building a multi-arch tree.
 *
 * FAIL-OPEN, ALWAYS. Every failure mode here leaves a larger but working install; none leaves
 * a broken one. If the host pair is absent the planner refuses to remove anything at all,
 * because a tree we cannot prove has a usable binary is a tree we must not touch. If a removal
 * throws, it is reported and skipped. The driver never exits non-zero: a size optimisation that
 * can fail an install is a worse trade than the bytes it saves.
 */
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

/**
 * Decide which `bin/napi-v3/<platform>/<arch>` directories may be removed.
 *
 * Pure, and separate from the filesystem on purpose — this is the part with a decision in it,
 * so it is the part that has to be testable without an npm install to run it against.
 *
 * @param tree    {Record<string, string[]>} platform dir -> arch dirs found under it
 * @param platform host `process.platform`
 * @param arch     host `process.arch`
 * @returns {{ keep: string|null, remove: string[], reason: string }} `remove` holds
 *          `"<platform>/<arch>"` paths relative to `bin/napi-v3`.
 */
export function planPlatformPrune(tree, platform, arch) {
  const host = `${platform}/${arch}`;
  const present = [];
  for (const [plat, arches] of Object.entries(tree)) {
    for (const a of arches) present.push(`${plat}/${a}`);
  }

  // ⚠ The refusal, and the reason it is first. If the host pair is not in the tree, we cannot
  // tell "already pruned" from "this package is laid out differently than we believe", and in
  // the second case every candidate for removal might be the one that gets loaded. Removing
  // nothing costs bytes; removing the wrong thing costs the user their install.
  if (!present.includes(host)) {
    return { keep: null, remove: [], reason: `host pair ${host} absent — refusing to prune` };
  }

  const remove = present.filter((p) => p !== host).sort();
  return {
    keep: host,
    remove,
    reason: remove.length ? `keeping ${host}, removing ${remove.length} non-host pair(s)` : `only ${host} present — nothing to do`,
  };
}

/*
 * ⚠ WHY THE SEARCH BELOW WALKS THE FILESYSTEM INSTEAD OF ASKING THE MODULE RESOLVER.
 *
 * This function used to reach the non-hoisted copies by resolving `<consumer>/package.json` for
 * each of `fastembed` and `@huggingface/transformers` and then resolving onnxruntime-node from
 * there. That branch could never contribute a root. Both packages declare an `exports` map with
 * no `./package.json` entry, so the FIRST resolve throws:
 *
 *     ERR_PACKAGE_PATH_NOT_EXPORTED: Package subpath './package.json' is not defined by
 *     "exports" in <...>/node_modules/fastembed/package.json
 *
 * — and identically for @huggingface/transformers. Only the hoisted lookup ever returned
 * anything, so the multi-copy tree this code exists to handle was silently skipped: the nested
 * copies kept their ~178 MiB while the install log reported a successful prune. Resolution
 * through the module system is gated by a manifest field that has nothing to do with whether a
 * directory is on disk; the sibling `locateWebRoot` in run.mjs had already hit this and already
 * answered it by walking directories, and this is the same answer.
 *
 * The walk is also strictly more general than the consumer list was. It finds a copy nested
 * under ANY package, not just the two we happen to know about — which is the case that produces
 * a second copy in the first place, since npm only nests when some dependent pinned a version
 * the hoisted copy cannot satisfy.
 */

const MAX_NEST_DEPTH = 6;

/**
 * Subdirectories of `dir`, FOLLOWING SYMLINKS, or `[]` when it cannot be read.
 *
 * ⚠ Same trap as run.mjs's `subdirs`: `Dirent.isDirectory()` describes the LINK, not its target,
 * and both npm and pnpm materialise packages as links. Filtering on it alone makes every linked
 * package invisible — which here means silently finding fewer copies to prune, the exact failure
 * this rewrite is fixing.
 */
function subdirsFollowingLinks(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => {
      if (e.isDirectory()) return true;
      if (!e.isSymbolicLink()) return false;
      try {
        return statSync(join(dir, e.name)).isDirectory();
      } catch {
        return false; // dangling link
      }
    })
    .map((e) => e.name);
}

/**
 * The root of the install `startDir` belongs to — the directory whose `node_modules` contains it.
 *
 * ⚠ THIS BOUND IS THE SAFETY PROPERTY, not a tidiness one. The obvious spelling is "walk up until
 * you find a node_modules", and from `~/project/node_modules/wigolo` that walk does not stop at
 * `~/project` — it keeps going and would happily delete binaries out of a `~/node_modules`
 * belonging to some other install that never asked to be pruned. Cutting at the LAST
 * `node_modules` segment of our own path answers "which tree am I part of" exactly.
 *
 * The fallback walk is for the other caller: a checkout, where nothing is under node_modules at
 * all, and the nearest ancestor that HAS one is the tree being operated on.
 */
export function findInstallRoot(startDir) {
  const abs = resolve(startDir);
  const parts = abs.split(sep);
  const i = parts.lastIndexOf('node_modules');
  if (i > 0) return parts.slice(0, i).join(sep) || sep;

  let dir = abs;
  for (;;) {
    if (existsSync(join(dir, 'node_modules'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Every `onnxruntime-node` package directory physically present in `startDir`'s install tree,
 * canonicalised so that two links onto one store entry count as the one copy they are.
 */
export function findOrtCopies(startDir, maxDepth = MAX_NEST_DEPTH) {
  const installRoot = findInstallRoot(startDir);
  if (!installRoot) return [];

  const found = new Set();

  const visitPackage = (pkgDir, name, depth) => {
    if (name === 'onnxruntime-node' && existsSync(join(pkgDir, 'package.json'))) {
      // realpath, because pnpm gives every dependent its own link to ONE store directory. Keyed
      // on the link path those would be N copies, pruned N times, each after the first reporting
      // bytes that are already gone. Keyed on the target they are what they are: one copy.
      try {
        found.add(realpathSync(pkgDir));
      } catch {
        found.add(pkgDir);
      }
    }
    const nested = join(pkgDir, 'node_modules');
    if (existsSync(nested)) scan(nested, depth + 1);
  };

  const scan = (modulesDir, depth) => {
    if (depth > maxDepth) return; // nested node_modules nest, but not without bound
    for (const name of subdirsFollowingLinks(modulesDir)) {
      if (name === '.bin') continue;
      const dir = join(modulesDir, name);
      if (name.startsWith('@')) {
        // A scope directory holds packages; it is not a nesting level of its own.
        for (const scoped of subdirsFollowingLinks(dir)) visitPackage(join(dir, scoped), scoped, depth);
        continue;
      }
      visitPackage(dir, name, depth);
    }
  };

  scan(join(installRoot, 'node_modules'), 0);
  return [...found];
}

/**
 * Every distinct `onnxruntime-node` install in the tree.
 *
 * Two strategies, unioned. `resolveFrom` is the module resolver's answer for the hoisted copy —
 * the one that delivers the whole win in an ordinary tree, and which handles the layouts the
 * resolver knows about and a directory walk does not. The on-disk scan from `scanFrom` is what
 * finds the copies hoisting did not produce. Keeping both is deliberate: this prune is fail-open
 * by contract, so two overlapping ways of finding a copy is the cheap side of the trade and the
 * Set makes the overlap free.
 *
 * Finding nothing is not an error. onnxruntime-node arrives through optional dependencies, and a
 * tree that never installed one is a tree with nothing to prune.
 */
export function locateOrtRoots(resolveFrom, scanFrom = null) {
  const roots = new Set();
  try {
    const dir = resolveFrom();
    if (dir) roots.add(dir);
  } catch {
    // Nothing hoisted, or nothing installed at all. The on-disk scan is the other half of the
    // answer and still gets its turn — if this throw aborted the walk, a tree that nested every
    // copy would keep all of them while the log said nothing.
  }
  if (scanFrom) {
    for (const dir of findOrtCopies(scanFrom)) roots.add(dir);
  }
  return [...roots];
}
