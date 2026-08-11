/*
 * Drop the browser WASM payload `onnxruntime-web` ships into a Node-only server.
 *
 * WHY THIS EXISTS. After the platform prune, `onnxruntime-web` is the LARGEST package in the
 * production tree — 91.1 MiB of a 503 MiB install measured on darwin-arm64 — and 86.1 MiB of
 * that is `dist/`: WebAssembly builds, WebGL and WebGPU bundles, and their source maps, for a
 * process that has no browser in it. `ort-wasm-simd-threaded.jsep.wasm` alone is 20.6 MiB.
 *
 * WHY IT IS SAFE, ESTABLISHED BY RUNNING THE CODE AND NOT BY READING IT.
 *
 *  1. `@huggingface/transformers` is the ONLY package in the tree that depends on
 *     onnxruntime-web (scanned across every package.json in a clean production install:
 *     exactly one dependent). It supports both backends and picks one at build time, not at
 *     runtime — its manifest has conditional `exports` sending Node to
 *     `dist/transformers.node.mjs`, and webpack compiled THAT bundle with onnxruntime-web
 *     replaced by an empty stub:
 *
 *         /***\/ "?8b6b":
 *         /*!*** onnxruntime-web (ignored) ***!
 *         /***\/ (() => { /* (ignored) *\/ }),
 *
 *  2. That was then confirmed by observation rather than inference. Running BOTH production ML
 *     paths in one process — embeddings through fastembed, cross-encoder reranking through
 *     @huggingface/transformers — and reading Node's CJS module registry afterwards shows
 *     `onnxruntime-node` loaded 5 files INCLUDING the native binding
 *     (`bin/napi-v3/darwin/arm64/onnxruntime_binding.node`) and `onnxruntime-web` loaded ZERO.
 *     The node-backend hit is the positive control: the probe can see a backend when one is
 *     used, so seeing none for the web backend means none was used.
 *
 *  3. With the package physically removed from the tree, both paths produce BIT-IDENTICAL
 *     output — 384 dims, 384/384 non-zero, paraphrase cosine 0.7702 against unrelated 0.3445,
 *     cross-encoder logits 9.9944 / -11.3984, all 16 recorded assertions unchanged.
 *
 * WHY IT CANNOT BE FIXED IN THE MANIFEST — AND WHY TRYING WOULD BE WORSE THAN DOING NOTHING.
 * The obvious remedy is an `overrides` entry pinning onnxruntime-web to a stub. npm honours
 * `overrides` ONLY from the install root, and wigolo is never the install root for its users —
 * `npx wigolo` and `npm i wigolo` both install it as a dependency. Measured on a control
 * fixture, both arms of it, because this repo has already shipped this mistake once (#101,
 * re-broken as #114):
 *
 *     overrides at the install ROOT   -> applied      (is-number 7.0.0)
 *     the SAME overrides one level down -> IGNORED    (is-number 6.0.0)
 *
 * ⚠ And the failure is invisible from inside the repo, which is the dangerous part. The G-DIET
 * budget gate installs this package.json into a temp directory AS THE ROOT, so an overrides
 * remedy would turn the gate green while every real user's install was byte-for-byte unchanged.
 * A postinstall runs wherever the package lands, root or not, so it is the mechanism that
 * actually reaches the users the gate is a proxy for.
 *
 * WHY `dist/` AND NOT THE WHOLE PACKAGE. Removing the directory outright would save a further
 * ~5 MiB and cost more than it saves: `npm ls` would report a missing dependency of
 * @huggingface/transformers, which is noise in every user's tree and a hard failure in
 * pipelines that run it strictly. Leaving the manifest, `lib/` and `types.d.ts` in place keeps
 * the dependency RESOLVABLE while removing the payload nothing loads. It also keeps the
 * failure loud rather than silent in the world where assumption (1) is someday wrong: the
 * package's `main` is `dist/ort.node.min.js`, so a consumer that did start requiring it gets an
 * immediate, named module error instead of a subtly degraded model.
 *
 * FAIL-OPEN, ALWAYS. Same contract as the platform prune: every failure mode leaves a larger
 * but working install. If any package other than @huggingface/transformers depends on
 * onnxruntime-web — a user's own application, most plausibly — this refuses entirely and keeps
 * the payload, because the bytes are not worth breaking somebody else's browser build.
 * `WIGOLO_SKIP_ORT_PRUNE=1` disables this along with the platform prune.
 */

/**
 * Decide whether the browser payload may be removed.
 *
 * Pure, and separate from the filesystem on purpose — the decision is the whole risk, so it is
 * the part that has to be testable without an npm install to run it against.
 *
 * @param dependents {string[]} names of every package in the tree declaring a dependency on
 *        onnxruntime-web. The install root, if it declares one, appears as the literal
 *        `'<install-root>'` — it is the most likely foreign consumer and must not be special.
 * @returns {{ remove: string[], reason: string }} `remove` holds paths relative to the
 *          onnxruntime-web package root.
 */
export function planWebPayloadPrune(dependents) {
  const OWNER = '@huggingface/transformers';

  // ⚠ The refusal, and the reason it is first. An empty dependent set does NOT mean "nobody
  // needs it, remove freely" — it means the scan found nothing, and a scan that found nothing
  // is far more likely to be a scan that failed (an unreadable manifest, a layout we do not
  // understand) than a package that installed itself for no reason. Treating a failed scan as
  // permission to delete is how a fail-open design quietly becomes fail-dangerous.
  if (dependents.length === 0) {
    return { remove: [], reason: 'no dependents found — refusing to prune (scan may have failed)' };
  }

  const foreign = [...new Set(dependents)].filter((d) => d !== OWNER).sort();
  if (foreign.length > 0) {
    return {
      remove: [],
      reason: `depended on by ${foreign.join(', ')} besides ${OWNER} — refusing to prune`,
    };
  }

  return { remove: ['dist'], reason: `${OWNER} is the only dependent — removing browser payload` };
}

/**
 * Every package name in `tree` that declares a dependency on onnxruntime-web.
 *
 * Pure over an already-read map so the traversal can be tested without a filesystem. Optional
 * and peer dependencies count: a package that lists onnxruntime-web as optional still loads it
 * when it IS present, which is exactly the state this prune would be changing.
 *
 * @param tree {Record<string, object>} package name -> its parsed package.json
 */
export function findWebDependents(tree) {
  const found = [];
  for (const [name, manifest] of Object.entries(tree)) {
    if (!manifest) continue;
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      if (manifest[field] && manifest[field]['onnxruntime-web']) {
        found.push(name);
        break;
      }
    }
  }
  return found.sort();
}
