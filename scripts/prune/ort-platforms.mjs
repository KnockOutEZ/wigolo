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

/**
 * Every distinct `onnxruntime-node` install in the tree.
 *
 * Resolution starts from the packages that actually depend on it rather than from this file,
 * because when wigolo is installed AS A DEPENDENCY its own directory is a sibling of the
 * hoisted `onnxruntime-node`, not a parent of it — and in a tree where hoisting was defeated
 * there can be more than one copy. A missing consumer is not an error: the optional-dependency
 * arrangement means a tree that never installed one is a tree with nothing to prune.
 */
export function locateOrtRoots(resolveFrom, consumers = ['fastembed', '@huggingface/transformers']) {
  const roots = new Set();
  for (const consumer of [null, ...consumers]) {
    try {
      const dir = resolveFrom(consumer);
      if (dir) roots.add(dir);
    } catch {
      // This consumer is not installed, or cannot see onnxruntime-node from where it sits.
      // Both are ordinary; the other candidates still get their turn.
    }
  }
  return [...roots];
}
