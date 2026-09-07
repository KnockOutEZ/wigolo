/*
 * The `libexec/` sidecar: the half of the artifact that is NOT inside the executable.
 *
 * WHY A SIDECAR AT ALL (DR-2). A Node SEA embeds exactly one thing: a JavaScript blob. It has
 * no virtual filesystem, and the `require()` handed to the embedded main "only supports loading
 * built-in modules" — Node says so itself, on stderr, on every single run. So every `.node`
 * addon, every companion `.dylib`, and every package esbuild cannot flatten into CJS has to
 * exist as a real file that a real `createRequire` can reach. `libexec/node_modules` is that
 * place, and the executable finds it relative to its own realpath (never an absolute build-time
 * path) — which is the whole of §4 G1.
 *
 * WHY THE CLOSURE IS COPIED FROM THE REPO'S OWN `node_modules` AND NOT INSTALLED FRESH.
 * `better-sqlite3`, `sharp` and `onnxruntime-node` fetch prebuilds for the RUNNING platform in
 * their install scripts, and `npm install --os=linux --cpu=x64` does not redirect them (spike
 * §2a). For the host target — the only target this slice builds — the repo's installed tree is
 * already the correct platform's tree, `npm ci` put it there from the same lockfile the harvest
 * asserts against, and copying it costs no network. Cross-target closures are BIN-4's problem
 * and need a per-platform build host, exactly as the spike's linux arm did.
 *
 * WHAT IS DELIBERATELY NOT HERE: the natives. This module stages the JS closure and whatever
 * platform binaries the repo's own install happens to carry; `harvest.mjs` then overlays the
 * OFFICIAL prebuilds for the pinned ABI on top. That order is the point — the harvest's
 * refuse-don't-compile guarantee (DR-3) is worth nothing if a host-compiled addon from the dev
 * tree is what ends up shipping, so the last writer of every native path must be the harvest.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * The 16 packages esbuild must NOT bundle, and why each one cannot be bundled.
 *
 * Two distinct reasons live in this one list, and conflating them is how the list rots:
 *
 *   NATIVE / PULLS-NATIVE / ASSET-LOADS — bundling would inline the package's JS while leaving
 *   its `.node`, `.dylib` or `.wasm` companion unreachable. The JS would load; the thing it
 *   dlopens would not.
 *
 *   TOP-LEVEL-AWAIT — esbuild cannot emit CJS for these AT ALL. `src/index.ts:70` documents the
 *   app entry's own no-TLA invariant, but the invariant has to cover the dependency closure:
 *   `ink/build/reconciler.js` and `yoga-layout/dist/src/index.js` each carry their own TLA and
 *   hard-ERROR the build. `react-devtools-core` is on the list for a third reason again — it is
 *   declared by `ink` but never installed (dev-only), so it is externalized purely to stop
 *   esbuild failing on an unresolvable import. It is not in the sidecar and is never required
 *   at runtime.
 */
export const EXTERNALS = Object.freeze([
  { name: 'better-sqlite3', reason: 'native' },
  { name: 'sqlite-vec', reason: 'native' },
  { name: 'onnxruntime-node', reason: 'native' },
  { name: 'sharp', reason: 'native' },
  { name: '@napi-rs/keyring', reason: 'native' },
  { name: 'wreq-js', reason: 'native' },
  { name: '@huggingface/transformers', reason: 'pulls-native' },
  { name: 'fastembed', reason: 'pulls-native' },
  { name: 'pdf-parse', reason: 'asset-loads' },
  { name: 'playwright', reason: 'browser-driver' },
  { name: 'playwright-core', reason: 'browser-driver' },
  { name: 'patchright', reason: 'browser-driver' },
  { name: 'chrome-remote-interface', reason: 'browser-driver' },
  { name: 'ink', reason: 'top-level-await' },
  { name: 'yoga-layout', reason: 'top-level-await' },
  { name: 'react-devtools-core', reason: 'declared-not-installed' },
]);

/** Externals that are expected to have no directory on disk — absence is correct, not a gap. */
const NOT_INSTALLED = new Set(['react-devtools-core']);

/**
 * Node's own resolution, restricted to directories.
 *
 * Written out rather than delegating to `createRequire(...).resolve()` because a package with
 * an `exports` map that does not expose `./package.json` — several here do not — makes
 * `resolve()` throw for a package that is present and perfectly loadable. Asking the filesystem
 * the question the filesystem can answer avoids inventing a failure.
 */
export function resolvePackageDir(fromDir, name, stopAt) {
  let dir = path.resolve(fromDir);
  const stop = path.resolve(stopAt);
  for (;;) {
    const candidate = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    if (dir === stop) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Transitive closure of `roots` over the repo's installed tree.
 *
 * OPTIONAL DEPENDENCIES ARE ALLOWED TO BE ABSENT AND REQUIRED ONES ARE NOT. `sharp` declares an
 * optional dependency on the sharp binary for EVERY platform; on a darwin host, four of them
 * were never installed and their absence is the correct state, not a broken tree. A missing
 * non-optional dependency is the opposite — it means the closure would ship a package whose
 * `require` fails at runtime — so it is collected and refused by the caller.
 *
 * PEER DEPENDENCIES ARE FOLLOWED WHEN INSTALLED. `ink` takes `react` as a peer, so a
 * dependencies-only walk stages an `ink` that cannot boot. Peers that are not installed are
 * skipped rather than refused: an unmet peer is a warning in npm's own model, and the packages
 * here that declare one they do not get are declaring it for a consumer, not for themselves.
 *
 * @returns {{ packages: Array<{name: string, dir: string, version: string}>, missing: string[] }}
 */
export function resolveClosure({ repoRoot, roots = EXTERNALS.map((e) => e.name) }) {
  const seen = new Map();
  const missing = [];
  const queue = roots.map((name) => ({ name, fromDir: repoRoot, via: '(root)' }));

  while (queue.length > 0) {
    const { name, fromDir, via } = queue.shift();
    if (seen.has(name)) continue;

    const dir = resolvePackageDir(fromDir, name, repoRoot);
    if (!dir) {
      if (!NOT_INSTALLED.has(name)) missing.push(`${name} (required by ${via})`);
      continue;
    }

    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    seen.set(name, { name, dir, version: pkg.version ?? '(none)' });

    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      queue.push({ name: dep, fromDir: dir, via: name });
    }
    // Optional and peer: present-or-skip. `resolvePackageDir` returning null for one of these
    // is a fact about this platform's install, not a defect, so they never reach `missing`.
    for (const dep of [...Object.keys(pkg.optionalDependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})]) {
      if (seen.has(dep)) continue;
      if (resolvePackageDir(dir, dep, repoRoot)) queue.push({ name: dep, fromDir: dir, via: name });
    }
  }

  return {
    packages: [...seen.values()].sort((a, b) => a.name.localeCompare(b.name)),
    missing: missing.sort(),
  };
}

/** Total bytes of a directory tree, following nothing — symlinks count as their own small selves. */
export function treeBytes(dir) {
  let total = 0;
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile()) total += fs.statSync(p).size;
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return total;
}

/**
 * Copy the closure into `<stageRoot>/libexec/node_modules`.
 *
 * `dereference: true` because the destination is a TARBALL. A symlink into the build host's
 * `node_modules` survives `cp` and dies in the archive — `cpSync` would happily record a link
 * to `/Users/<someone>/…`, which unpacks on the user's machine as a dangling pointer and fails
 * at `dlopen` time with an ENOENT naming a path that never existed there. `.bin/` is skipped
 * for the same reason and one more: its entries are shims that re-enter the host's `node`.
 */
export function stageClosure({ repoRoot, stageRoot, roots }) {
  const { packages, missing } = resolveClosure({ repoRoot, roots });
  if (missing.length > 0) {
    throw new Error(
      `REFUSED — the sidecar closure is incomplete; these are declared dependencies with no directory in ${repoRoot}/node_modules:\n  ` +
        `${missing.join('\n  ')}\n` +
        '  Run `npm ci` and rebuild. Staging an incomplete closure ships a binary that fails at first require().'
    );
  }

  const modulesRoot = path.join(stageRoot, 'libexec', 'node_modules');
  fs.mkdirSync(modulesRoot, { recursive: true });
  for (const pkg of packages) {
    const dest = path.join(modulesRoot, pkg.name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(pkg.dir, dest, {
      recursive: true,
      dereference: true,
      filter: (src) => path.basename(src) !== '.bin',
    });
  }
  return packages;
}

/**
 * The app mirror at `<stageRoot>/libexec/app`.
 *
 * THREE `package.json` COPIES, NOT ONE. Seven call sites in `src/` read the package version by
 * walking up from `import.meta.url`, at three different dist depths, and three of them do it
 * with a raw `readFileSync` that no `require` shim can intercept. `src/server.ts` does it inside
 * a `catch` that returns `'0.0.0'` — during the spike that silently reported `serverInfo.version:
 * "0.0.0"` to every MCP client while `--version` printed the right answer. Mirroring the file at
 * each depth is the only fix that reaches all seven without rewriting them.
 *
 * `assets/` AND `skills/` because `readAsset()` and the skills catalog do not read a known list
 * of files — the catalog `readdirSync`s the `skills/` directory and hashes what it finds. There
 * is no shim for an enumeration; the directory has to be there.
 */
export function stageAppMirror({ repoRoot, stageRoot, mirrors, semver }) {
  const appRoot = path.join(stageRoot, 'libexec', 'app');
  const pkgJson = fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8');

  const parsed = JSON.parse(pkgJson);
  if (parsed.version !== semver) {
    throw new Error(`package.json version ${parsed.version} != the semver being built (${semver})`);
  }

  for (const rel of mirrors) {
    const dest = path.join(appRoot, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, pkgJson);
  }

  for (const dir of ['assets', 'skills']) {
    const from = path.join(repoRoot, dir);
    if (!fs.existsSync(from)) throw new Error(`app mirror needs ${dir}/ and it is not in ${repoRoot}`);
    fs.cpSync(from, path.join(appRoot, dir), { recursive: true, dereference: true });
  }

  return appRoot;
}

/**
 * The onnxruntime trim (spike §2a M4) — a MANDATORY build step, not an optimization.
 *
 * `onnxruntime-node` ships every platform it supports in one package, and on linux that
 * includes a 327 MB CUDA execution provider and a TensorRT one for hardware this artifact will
 * never see. Untrimmed, the linux closure tars to 428 MiB against a 200 MB budget — 2.1x over,
 * with the entire overage in files no wigolo code path can reach.
 *
 * THE REASON THIS CANNOT BE LEFT TO THE INSTALLER: it is not uniform. The darwin `npm install`
 * DOES prune to the host platform and the linux one does NOT, so a build that assumes the
 * installer did it is correct on the machine it was written on and 2x over budget everywhere
 * else. The spike re-ran the full six-native probe battery after this trim on linux: all six
 * still pass and the embedding values are unchanged.
 *
 * `onnxruntime-web` (92 MB) is deliberately NOT trimmed. It is measured, and dropping it would
 * take linux to ~82 MiB, but it is the wasm backend for `@huggingface/transformers` and may back
 * the reranker — the one native whose OPERATION the spike never exercised. Trimming a thing you
 * have not proven unreachable is how a capability disappears silently.
 */
export function trimOnnxruntime({ stageRoot, target }) {
  const [platform, arch] = [target.slice(0, target.indexOf('-')), target.slice(target.indexOf('-') + 1)];
  const napiRoot = path.join(stageRoot, 'libexec', 'node_modules', 'onnxruntime-node', 'bin', 'napi-v3');
  if (!fs.existsSync(napiRoot)) return { removed: [], reason: 'onnxruntime-node/bin/napi-v3 absent — nothing to trim' };

  const hostDir = path.join(napiRoot, platform, arch);
  // The same refusal shape `scripts/prune/ort-platforms.mjs` opens with, and for the same
  // reason: if the pair we intend to KEEP is not there, we cannot tell "already trimmed" from
  // "laid out differently", and in the second case every removal candidate might be the one
  // that gets loaded. Removing nothing costs bytes; removing the wrong thing costs the artifact.
  if (!fs.existsSync(hostDir)) {
    return { removed: [], reason: `${platform}/${arch} absent under bin/napi-v3 — refusing to trim` };
  }

  const removed = [];
  for (const entry of fs.readdirSync(napiRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === platform) continue;
    const p = path.join(napiRoot, entry.name);
    removed.push({ path: path.relative(stageRoot, p), bytes: treeBytes(p) });
    fs.rmSync(p, { recursive: true, force: true });
  }
  for (const sibling of fs.readdirSync(path.join(napiRoot, platform), { withFileTypes: true })) {
    if (!sibling.isDirectory() || sibling.name === arch) continue;
    const p = path.join(napiRoot, platform, sibling.name);
    removed.push({ path: path.relative(stageRoot, p), bytes: treeBytes(p) });
    fs.rmSync(p, { recursive: true, force: true });
  }

  // The two execution providers. Named individually rather than by a `providers_` glob because
  // the CPU provider is also a `providers_` file on some builds, and it is the one that runs.
  for (const name of ['libonnxruntime_providers_cuda.so', 'libonnxruntime_providers_tensorrt.so']) {
    const p = path.join(hostDir, name);
    if (!fs.existsSync(p)) continue;
    removed.push({ path: path.relative(stageRoot, p), bytes: fs.statSync(p).size });
    fs.rmSync(p, { force: true });
  }

  return { removed, reason: `kept ${platform}/${arch}, removed ${removed.length} non-host item(s)` };
}
