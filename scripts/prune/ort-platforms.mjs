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

/**
 * How many levels of nested `node_modules` the on-disk walk descends.
 *
 * Exported so the test that proves the module-resolver branch still contributes can build its
 * fixture FROM this number. Hardcoding the depth there would turn that test into a test of
 * nothing the first time somebody raised the bound.
 */
export const MAX_NEST_DEPTH = 6;

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
 * ⚠ WHY THE PATH IS CUT RATHER THAN WALKED. The obvious spelling is "walk up until you find a
 * node_modules", and its failure is that it stops too EARLY, not too late: from
 * `~/project/node_modules/wigolo` it returns wigolo's OWN directory the moment wigolo has nested
 * dependencies of its own, and then scans only wigolo's private subtree — finding neither the
 * hoisted copy nor a sibling's nested one. (It cannot escape UPWARD from a dependency install:
 * `~/project/node_modules` is on the path, so the walk always halts at `~/project` at the latest.)
 * Cutting at the LAST `node_modules` segment answers "which tree am I part of" directly, and is
 * the difference between finding both copies and finding none.
 */
export function findInstallRoot(startDir) {
  const abs = resolve(startDir);
  const parts = abs.split(sep);
  const i = parts.lastIndexOf('node_modules');
  if (i > 0) return parts.slice(0, i).join(sep) || sep;

  // Not under a node_modules at all: a checkout, or the throwaway tree the budget gate points
  // argv[2] at. ⚠ Bounded to the caller's OWN package — the nearest ancestor holding a
  // package.json, accepted only if it has a node_modules. Walking up for the first node_modules
  // instead WOULD escape here, because unlike the branch above there is no node_modules on the
  // path to halt it: from a checkout that has not been installed yet it sails past the checkout
  // and returns whatever unrelated install happens to sit above it.
  let dir = abs;
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) {
      return existsSync(join(dir, 'node_modules')) ? dir : null;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Is `dir` ITSELF an installed package — a package directory sitting directly in a `node_modules`,
 * or in a scope directory inside one?
 *
 * ⚠ NOT "does `dir` have a node_modules anywhere on its path", which is the looser spelling and
 * gets one case wrong that matters: a project checked out at `outer/node_modules/pkg/proj` has
 * `node_modules` on its path and is emphatically NOT a package of `outer` — nothing installed it
 * there. The loose predicate climbs to `outer` from such a checkout and hands back exactly the
 * escape this bound exists to close.
 */
function isInstalledPackageDir(dir) {
  const parent = dirname(dir);
  if (parent === dir) return false;
  const parentName = parent.split(sep).pop();
  if (parentName === 'node_modules') return true;
  // `@scope` is a directory in the layout but not a level of the dependency graph, so a scoped
  // package sits one deeper than an unscoped one.
  if (parentName?.startsWith('@')) return dirname(parent).split(sep).pop() === 'node_modules';
  return false;
}

/**
 * The OUTERMOST install root `startDir` belongs to — the whole npm tree, not just the immediate
 * package that holds it. `null` when no tree can be claimed.
 *
 * ⚠ THIS IS THE ONE NOTION OF TREE IDENTITY. Every prune in this directory bounds itself with it,
 * because two prunes disagreeing about which files are "ours" is how one of them ends up deleting
 * a stranger's binaries while the other correctly refuses.
 *
 * The rule is a single distinction, applied repeatedly: from the immediate install root, keep
 * climbing WHILE that root is itself an installed package, and stop the moment it is not.
 *
 *   <root>/node_modules/foo/node_modules/wigolo   -> <root>
 *       `foo` is a package OF <root>'s tree, so a copy hoisted to <root>/node_modules is ours
 *       exactly as much as `foo` is. This is the case #307 gave up.
 *
 *   outer/proj/node_modules/wigolo                -> outer/proj
 *       `proj` is not installed into `outer`; it is a DIFFERENT PROJECT that happens to sit one
 *       directory down. `outer/node_modules` belongs to somebody else and climbing there is the
 *       ~178 MiB escape. Node's own resolver makes no such distinction — it walks straight past
 *       `proj` — which is why the resolver's answer has to be checked against this and not
 *       trusted on its own.
 *
 * ⚠ WHAT THIS COSTS, AND IT IS A NEW LOSS RATHER THAN AN INHERITED ONE. Two layouts put wigolo
 * somewhere that is NOT an installed package, with the dependency hoisted above it:
 *
 *   npm workspaces   <repo>/packages/app/node_modules/wigolo, dependency at <repo>/node_modules
 *   Yarn PnP         <proj>/.yarn/unplugged/wigolo-npm-.../node_modules/wigolo, likewise
 *
 * In both, `packages/app` and the unplugged directory are not packages of anything, so the climb
 * stops there and the hoisted copy keeps its bytes.
 *
 * ⚠ FOR THE ONNXRUNTIME PLATFORM PRUNE THAT IS A REGRESSION AGAINST THE PREVIOUS COMMIT, and
 * saying otherwise would misdescribe when we started losing the bytes. Measured on both layouts:
 * before the bound, the UNBOUNDED module resolver climbed straight past `packages/app` and pruned
 * the hoisted copy (6 pairs -> 1); with the bound it prunes nothing (6 pairs). It is only for
 * `wreq-js` and `onnxruntime-web` that this is inherited — their walk was already bounded at the
 * immediate install root by #307, and it measures 7 binaries kept on BOTH sides.
 *
 * The trade is still the right one: the same unbounded reach that pruned the workspace copy is
 * what deleted a stranger's ~178 MiB, and this direction only ever costs install size. But it is a
 * trade, so the driver SAYS SO rather than falling silent — see run.mjs's empty-result branch.
 *
 * Telling these layouts apart from `outer/proj` means reading `<repo>`'s `workspaces` field (or
 * PnP's manifest). That is declarative data, not a guess, so it is not unsafe — it is
 * disproportionate here, and it would need its own must-not-fire coverage before it could be
 * trusted to widen a destructive bound.
 */
export function findOutermostInstallRoot(startDir) {
  let root = findInstallRoot(startDir);
  if (!root) return null;
  const seen = new Set();
  while (isInstalledPackageDir(root) && !seen.has(root)) {
    seen.add(root);
    const next = findInstallRoot(root);
    if (!next || next === root) break;
    root = next;
  }
  return root;
}

/** `path`, canonicalised, or the resolved path when it cannot be (gone, or not permitted). */
function realOrResolved(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Is `candidate` inside `tree`?
 *
 * Canonicalised on both sides because macOS's tmpdir is `/var -> /private/var` and the module
 * resolver reports the resolved path, so the two halves would otherwise disagree about identical
 * directories. The separator on the prefix is not decoration either: without it `outer/proj` would
 * claim `outer/project-b`.
 *
 * ⚠ CASE-FOLDED ON WIN32 ONLY. The two sides reach here from different Node APIs — one from
 * `import.meta.url`, one from `require.resolve` — and on a case-insensitive filesystem a drive
 * letter or path segment that differs only in case names the SAME directory. Comparing them
 * literally there would reject our own tree and silently cost the win on every Windows install,
 * which is the failure that gets discovered in CI rather than here. Folding elsewhere would be
 * wrong for the opposite reason: on a case-sensitive filesystem `/a/Proj` and `/a/proj` are two
 * directories, and treating them as one is how a bound starts claiming a tree it does not own.
 */
export function isWithinTree(tree, candidate) {
  if (!tree) return false;
  const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const root = fold(realOrResolved(tree));
  const child = fold(realOrResolved(candidate));
  return child === root || child.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * Every `onnxruntime-node` package directory physically present in `startDir`'s install tree,
 * canonicalised so that two links onto one store entry count as the one copy they are.
 *
 * ⚠ SCOPED TO THE WHOLE TREE, not to the immediate install root. From
 * `<root>/node_modules/foo/node_modules/wigolo` the immediate root is `<root>/node_modules/foo`,
 * whose subtree holds no onnxruntime-node at all — the hoisted copy is a level above and a
 * sibling's nested copy is off to the side, and both are as much part of `<root>`'s tree as `foo`
 * is. Scanning only `foo` left ~178 MiB of them behind while the install log reported success.
 */
export function findOrtCopies(startDir, maxDepth = MAX_NEST_DEPTH) {
  const installRoot = findOutermostInstallRoot(startDir);
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
 * Two strategies, unioned, and NEITHER is redundant.
 *
 * The on-disk scan from `scanFrom` finds the copies hoisting did not produce — every nested copy
 * in the install tree, which the resolver cannot reach.
 *
 * `resolveFrom` is the module resolver's answer, and it is load-bearing in exactly the case the
 * scan is blind to: when the caller sits BELOW the level the copies live at. wigolo installed as
 * `<root>/node_modules/foo/node_modules/wigolo` has an install root of `<root>/node_modules/foo`,
 * whose subtree holds no onnxruntime-node at all — the hoisted copy at `<root>/node_modules` is
 * above it and a sibling's nested copy is off to the side. Node's own upward resolution is what
 * still finds the hoisted one from there. Delete this branch and that tree prunes nothing.
 *
 * ⚠ AND WHY THE RESOLVER'S ANSWER IS CHECKED RATHER THAN TRUSTED. Node's resolution walks
 * `node_modules` ancestors until something matches and has no notion of where our install stops,
 * so from `outer/proj/node_modules/wigolo` — wigolo installed into `proj` with no onnxruntime-node
 * beside it — it sails past `proj` and answers with `outer/node_modules/onnxruntime-node`, ~178
 * MiB belonging to a different project. That was REPRODUCED, not theorised: the driver printed
 * `kept darwin/arm64, removed darwin/x64, linux/arm64, ...` against the stranger's tree while npm
 * reported a successful install. #304 bounded the on-disk scan for precisely this and left the
 * resolver unbounded; the resolver is live here for a reason peculiar to this package —
 * onnxruntime-node declares NO `exports` map, so `./package.json` resolves and reaches upward,
 * where wreq-js's exports map made the same trick unavailable and the branch dead.
 *
 * `scanFrom` is therefore REQUIRED and not a convenience: it is what the tree boundary is derived
 * from, and without one there is no claim to check the resolver against. No claim, no prune.
 *
 * Finding nothing is not an error. onnxruntime-node arrives through optional dependencies, and a
 * tree that never installed one is a tree with nothing to prune.
 */
export function locateOrtRoots(resolveFrom, scanFrom) {
  const tree = scanFrom ? findOutermostInstallRoot(scanFrom) : null;
  if (!tree) return [];

  const roots = new Set();
  try {
    const dir = resolveFrom();
    // Canonicalised so the resolver's answer and the scan's dedup on the one copy they both find.
    if (dir && isWithinTree(tree, dir)) roots.add(realOrResolved(dir));
  } catch {
    // Nothing hoisted, or nothing installed at all. The on-disk scan is the other half of the
    // answer and still gets its turn — if this throw aborted the walk, a tree that nested every
    // copy would keep all of them while the log said nothing.
  }
  for (const dir of findOrtCopies(scanFrom)) roots.add(dir);
  return [...roots];
}
