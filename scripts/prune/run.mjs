#!/usr/bin/env node
/*
 * postinstall driver for the onnxruntime-node platform prune. See ./ort-platforms.mjs for
 * why the prune is safe and what it costs; this file is only the I/O around that decision.
 *
 * Runs on every `npm install` of wigolo, including as a dependency. It is idempotent — a
 * second run finds only the host pair and reports "nothing to do" — which matters because
 * npm re-runs a package's postinstall on installs that did not re-extract that package.
 */
import { createRequire } from 'node:module';
import { readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { planPlatformPrune, locateOrtRoots } from './ort-platforms.mjs';

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

/** Resolve the onnxruntime-node package root, optionally as `consumer` would see it. */
function resolveOrtRoot(consumer) {
  const paths = consumer ? [dirname(require.resolve(`${consumer}/package.json`))] : undefined;
  return dirname(require.resolve('onnxruntime-node/package.json', paths ? { paths } : undefined));
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

function main() {
  if (process.env.WIGOLO_SKIP_ORT_PRUNE) {
    console.log('wigolo: onnxruntime platform prune skipped (WIGOLO_SKIP_ORT_PRUNE set)');
    return;
  }

  const roots = locateOrtRoots(resolveOrtRoot);
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
