#!/usr/bin/env node
/*
 * postinstall driver for the install-size prunes. See ./ort-platforms.mjs (non-host onnxruntime
 * binaries), ./ort-web-payload.mjs (browser WASM payload) and ./wreq-binaries.mjs (non-host
 * TLS-impersonation binaries) for why each is safe and what it costs; this file is only the I/O
 * around those decisions.
 *
 * Runs on every `npm install` of wigolo, including as a dependency. Every prune is idempotent —
 * a second run finds nothing left to remove and says so — which matters because npm re-runs a
 * package's postinstall on installs that did not re-extract that package.
 */
import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planPlatformPrune, locateOrtRoots, findOutermostInstallRoot } from './ort-platforms.mjs';
import { planWebPayloadPrune, findWebDependents } from './ort-web-payload.mjs';
import { planBinaryPrune } from './wreq-binaries.mjs';

/*
 * Resolution base. As a postinstall this is the package's own directory, which is what walks up
 * to the hoisted `onnxruntime-node` a user installed. An explicit argv[1] overrides it so the
 * budget gate can point this at the throwaway tree it just built.
 *
 * ⚠ The override is not a convenience. Without it the gate — which runs this from a checkout —
 * would resolve through the CHECKOUT's node_modules and prune the developer's own dev tree
 * while claiming to have measured a temporary one.
 */
const base = process.argv[2] ? join(resolve(process.argv[2]), 'noop.cjs') : import.meta.url;
const require = createRequire(base);

/*
 * The same base as a plain directory, for the lookups that walk the filesystem instead of going
 * through the module resolver. Kept next to `base` so the two can never disagree about which
 * tree is being operated on — the gate's whole reason for passing argv[2].
 */
const baseFile = process.argv[2] ? join(resolve(process.argv[2]), 'noop.cjs') : fileURLToPath(import.meta.url);

/**
 * Resolve the hoisted onnxruntime-node package root.
 *
 * Only the hoisted copy: onnxruntime-node declares no `exports` map, so `./package.json` resolves
 * here, but the CONSUMERS of it do declare one and cannot be resolved through at all. Finding the
 * non-hoisted copies is locateOrtRoots' on-disk scan, not this — see its note.
 */
function resolveOrtRoot() {
  return dirname(require.resolve('onnxruntime-node/package.json'));
}

/*
 * Directory entries of `dir`, FOLLOWING SYMLINKS.
 *
 * ⚠ `Dirent.isDirectory()` is false for a symlink that points at a directory — it describes the
 * link, not the target. An installer that materialises any part of this layout as a link would
 * therefore make that platform invisible here. That direction is safe (the planner refuses when
 * it cannot see the host pair, so nothing is deleted) but it silently costs the whole win, and a
 * prune that quietly does nothing is worse than one that fails loudly. `statSync` follows the
 * link and answers the question actually being asked: can this be descended into.
 */
function subdirs(dir) {
  return readdirSync(dir, { withFileTypes: true })
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

/** `<root>/bin/napi-v3` as `{ platform: [arch, ...] }`; `null` when the layout is not there. */
function readPlatformTree(binRoot) {
  let platforms;
  try {
    platforms = subdirs(binRoot);
  } catch {
    return null;
  }
  const tree = {};
  for (const p of platforms) {
    try {
      tree[p] = subdirs(join(binRoot, p));
    } catch {
      tree[p] = [];
    }
  }
  return tree;
}

function dirSizeBytes(path) {
  let total = 0;
  const walk = (p) => {
    for (const e of readdirSync(p, { withFileTypes: true })) {
      const child = join(p, e.name);
      if (e.isDirectory()) walk(child);
      else {
        try { total += statSync(child).size; } catch { /* raced away */ }
      }
    }
  };
  try { walk(path); } catch { /* gone */ }
  return total;
}

/**
 * Find an installed package root by walking up from `startDir`, checking for a
 * `node_modules/<name>` at each level. Returns `null` when there is none.
 *
 * ⚠ DELIBERATELY NOT `require.resolve('<name>/package.json')`, which is the obvious spelling and
 * does not work. onnxruntime-web, @huggingface/transformers, fastembed AND wreq-js all declare
 * an `exports` map with no `./package.json` entry, so that call throws
 * ERR_PACKAGE_PATH_NOT_EXPORTED rather than returning a path — verified against a clean
 * production tree for all four. Resolution through the module system is gated by a manifest
 * field that has nothing to do with whether the directory is on disk; walking the directory tree
 * asks the question actually being asked.
 *
 * Walking up covers the three layouts that matter without special-casing any of them: this
 * package as the install root, this package installed as a dependency with `<name>` hoisted
 * beside it, and `<name>` nested under this package.
 *
 * ⚠ BOUNDED AT OUR OWN TREE, and the bound is load-bearing rather than tidiness. An unbounded walk
 * climbs to the filesystem root, so from `outer/proj/node_modules/wigolo` — with wigolo installed
 * `--omit=optional` and no `<name>` beside it — it sails past `proj`'s own package.json AND its
 * own node_modules and finds `outer/node_modules/<name>`, which belongs to a different project. It
 * then deletes six of its seven binaries. That tree may be multi-arch on purpose (a Docker build
 * context, a multi-platform CI cache) and its owner has no reason to have set
 * `WIGOLO_SKIP_ORT_PRUNE`. This is the same defect #304 fixed for the onnxruntime on-disk scan, so
 * this shares THAT notion of "which tree am I part of" rather than inventing a second one.
 *
 * ⚠ THE BOUND IS THE OUTERMOST INSTALL ROOT, NOT THE IMMEDIATE ONE, and the difference is a case
 * #307 gave up on. wigolo installed as `<root>/node_modules/foo/node_modules/wigolo` has an
 * IMMEDIATE install root of `<root>/node_modules/foo`, so a copy hoisted above that — at
 * `<root>/node_modules/<name>` — used to be out of reach and kept its bytes. But `foo` is itself a
 * package OF `<root>`'s tree, so `<root>/node_modules` is ours exactly as much as `foo` is;
 * `outer/proj` is NOT a package of `outer` and stays out of reach. `findOutermostInstallRoot`
 * draws that line, and it is what lets both facts hold at once.
 *
 * ⚠ #307'S NOTE UNDERSTATED WHAT THAT COST, and the correction is the reason this was worth
 * fixing rather than accepting. It called the above-root placement an edge case. The RARE part is
 * wigolo being nested at all — that needs a version conflict. Conditional on it happening, npm's
 * hoisting makes the above-root placement the LIKELY one, because hoisting is precisely what puts
 * a shared dependency at the top of the tree. So the old bound was costing the bytes in most of
 * the cases where it applied, not in a corner of them.
 */
function locatePackageRoot(startDir, name) {
  const installRoot = findOutermostInstallRoot(startDir);
  // No install root means no tree we can claim, and a prune with no claim is one that must not
  // run. Returning null here is the same fail-open the rest of this file takes.
  if (!installRoot) return null;

  let dir = resolve(startDir);
  const stop = resolve(installRoot);
  for (;;) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    if (dir === stop) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Read every package.json reachable under `modulesDir`, including nested `node_modules` and
 * scoped directories, as a LIST.
 *
 * ⚠ A list and not a map, because the same package name legitimately appears more than once in
 * an npm tree when versions conflict, and collapsing those copies can hide a dependent — see
 * findWebDependents' note. Deduplication belongs on the answer, not on the input.
 */
function readManifests(modulesDir) {
  const manifests = [];
  const walk = (dir, depth) => {
    if (depth > 6) return; // nested node_modules nest, but not without bound
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      const child = join(dir, e.name);
      if (e.name.startsWith('@')) {
        walk(child, depth); // scope dir holds packages, not a nesting level
        continue;
      }
      if (e.name === '.bin') continue;
      try {
        const manifest = JSON.parse(readFileSync(join(child, 'package.json'), 'utf8'));
        if (manifest?.name) manifests.push(manifest);
      } catch {
        // Not a package, or an unreadable manifest. Skipping it can only shrink the dependent
        // set, and a smaller dependent set can only make the planner MORE willing to prune —
        // so this is the one place the traversal must not be silently lossy. It is acceptable
        // only because the planner refuses outright on an empty set; a partial scan that still
        // finds @huggingface/transformers is a scan that found the package that matters.
      }
    }
  };
  walk(modulesDir, 0);
  return manifests;
}

/**
 * Remove `onnxruntime-web/dist` when @huggingface/transformers is its only dependent.
 *
 * Resolved through the transformers package so it finds the copy that package would load,
 * wherever hoisting put it.
 */
function pruneWebPayload() {
  const webRoot = locatePackageRoot(dirname(baseFile), 'onnxruntime-web');
  if (!webRoot) return; // not installed, or a layout we do not recognise; nothing to do

  const modulesDir = dirname(webRoot);
  const manifests = readManifests(modulesDir);
  // The install root is the most plausible foreign consumer and it does not live under
  // node_modules, so it is read separately. Its own name is replaced with a marker no real
  // package can take, because "your application" is what makes the refusal message legible.
  try {
    const rootManifest = JSON.parse(readFileSync(join(dirname(modulesDir), 'package.json'), 'utf8'));
    if (rootManifest) manifests.push({ ...rootManifest, name: '<install-root>' });
  } catch { /* no root manifest visible; the node_modules scan still stands */ }

  const plan = planWebPayloadPrune(findWebDependents(manifests));
  if (plan.remove.length === 0) {
    console.log(`wigolo: onnxruntime-web payload prune — ${plan.reason}`);
    return;
  }

  let freed = 0;
  for (const rel of plan.remove) {
    const target = join(webRoot, rel);
    if (!existsSync(target)) continue; // already pruned — idempotent
    try {
      freed += dirSizeBytes(target);
      rmSync(target, { recursive: true, force: true });
    } catch (err) {
      // Fail-open, same contract as the platform prune: a directory we could not remove is a
      // directory that stays. Larger, works.
      console.log(`wigolo: could not remove onnxruntime-web/${rel} (${err?.message ?? err}) — leaving it in place`);
    }
  }
  console.log(
    freed > 0
      ? `wigolo: onnxruntime-web payload prune — ${plan.reason} (${Math.round(freed / 1048576)} MiB)`
      : 'wigolo: onnxruntime-web payload prune — already removed, nothing to do',
  );
}

/**
 * Remove the `wreq-js` native binaries the host can never load.
 *
 * See ./wreq-binaries.mjs for why the manifest cannot do this, why linux keeps two files, and
 * why removal is allowlisted. This function is only the I/O around that decision.
 */
function pruneWreqBinaries() {
  const root = locatePackageRoot(dirname(baseFile), 'wreq-js');
  if (!root) return; // optional dependency, and `--omit=optional` is a supported install

  const rustDir = join(root, 'rust');
  let present;
  try {
    present = readdirSync(rustDir, { withFileTypes: true })
      .filter((e) => e.isFile() || e.isSymbolicLink())
      .map((e) => e.name);
  } catch {
    return; // no `rust/` — a layout we do not recognise, so nothing to do
  }

  const plan = planBinaryPrune(present, process.platform, process.arch);
  if (plan.remove.length === 0) {
    console.log(`wigolo: wreq-js binary prune — ${plan.reason}`);
    return;
  }

  let freed = 0;
  for (const name of plan.remove) {
    const target = join(rustDir, name);
    try {
      freed += statSync(target).size;
      rmSync(target, { force: true });
    } catch (err) {
      // Fail-open, same contract as the onnxruntime prunes: a file we could not remove is a
      // file that stays. Larger, works.
      console.log(`wigolo: could not remove wreq-js/rust/${name} (${err?.message ?? err}) — leaving it in place`);
    }
  }
  console.log(`wigolo: wreq-js binary prune — ${plan.reason} (${Math.round(freed / 1048576)} MiB)`);
}

function main() {
  if (process.env.WIGOLO_SKIP_ORT_PRUNE) {
    console.log('wigolo: install-size prunes skipped (WIGOLO_SKIP_ORT_PRUNE set)');
    return;
  }

  // Independently guarded: the prunes are unrelated wins on unrelated packages, and a failure in
  // one must not cost the others their bytes.
  try {
    pruneWebPayload();
  } catch (err) {
    console.log(`wigolo: onnxruntime-web payload prune skipped (${err?.message ?? err})`);
  }

  try {
    pruneWreqBinaries();
  } catch (err) {
    console.log(`wigolo: wreq-js binary prune skipped (${err?.message ?? err})`);
  }

  const roots = locateOrtRoots(resolveOrtRoot, dirname(baseFile));
  if (roots.length === 0) return; // nothing installed it; nothing to do

  for (const root of roots) {
    let freed = 0; // per-root: two copies in one tree must not report each other's bytes
    const binRoot = join(root, 'bin', 'napi-v3');
    const tree = readPlatformTree(binRoot);
    if (!tree) continue;

    const plan = planPlatformPrune(tree, process.platform, process.arch);
    if (plan.remove.length === 0) {
      console.log(`wigolo: onnxruntime platform prune — ${plan.reason}`);
      continue;
    }
    for (const rel of plan.remove) {
      const target = join(binRoot, ...rel.split('/'));
      try {
        freed += dirSizeBytes(target);
        rmSync(target, { recursive: true, force: true });
      } catch (err) {
        // Fail-open: a directory we could not remove is a directory that stays. Larger, works.
        console.log(`wigolo: could not remove ${rel} (${err?.message ?? err}) — leaving it in place`);
      }
    }
    // Platform dirs whose every arch just went are now empty shells. Removing them is
    // cosmetic — an empty dir costs nothing and the second run is already idempotent without
    // this — but a tree that lists `linux` and `win32` after a prune invites the reader to
    // conclude the prune did not happen.
    for (const plat of Object.keys(tree)) {
      if (plat === process.platform) continue;
      try {
        if (readdirSync(join(binRoot, plat)).length === 0) rmSync(join(binRoot, plat), { recursive: true, force: true });
      } catch { /* already gone, or not ours to remove */ }
    }
    console.log(
      `wigolo: onnxruntime platform prune — kept ${plan.keep}, removed ${plan.remove.join(', ')} (${Math.round(freed / 1048576)} MiB)`,
    );
  }
}

try {
  main();
} catch (err) {
  // ⚠ The install must survive anything this script does. The prune is an optimisation; a
  // failed optimisation that fails the install is strictly worse than the bytes it saves.
  console.log(`wigolo: onnxruntime platform prune skipped (${err?.message ?? err})`);
}
