#!/usr/bin/env node
/*
 * Build the mini-spec 4 artifact for one target. One command:
 *
 *   node scripts/binary/build.mjs                 # host target
 *   node scripts/binary/build.mjs --target linux-x64 --out /tmp/b
 *
 * TOOLCHAIN: Node SEA (mini-spec DR-9). An esbuild CJS bundle of the shipped `dist/index.js`
 * goes into a SEA blob, the blob is postject-ed into an OFFICIAL nodejs.org binary — never the
 * build host's node, which is what shipped an unredistributable runtime in SD-234-1 — and the
 * natives ride alongside in `libexec/` (DR-2). The versions of every one of those moving parts
 * live in `runtime.json` and nowhere else.
 *
 * THE ORDER OF THE STEPS IS PART OF THE DESIGN, twice over:
 *
 *   - the sidecar JS closure is staged BEFORE the harvest, so the LAST writer of every native
 *     path is the harvest's official prebuild. Reversed, a host-compiled addon from the dev
 *     tree would silently be what ships, and refuse-don't-compile (DR-3) would be a comment.
 *   - the surviving-`import(` gate runs BEFORE anything is sealed. esbuild preserved six
 *     runtime-fatal `import()` calls during the spike with ZERO warnings at
 *     `--log-level=verbose`; a green, silent build shipped a broken embedding path, a broken
 *     image path and broken optional-dependency loading. The bundler will not tell you, so the
 *     build has to look for itself.
 *
 * NON-GOALS, per the issue: no cross-platform matrix (targets other than the host build only
 * as far as the toolchain allows and are not verified here), and no install.sh.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readManifest, REPO_ROOT } from './manifest.mjs';
import { harvestTarget } from './harvest.mjs';
import { EXTERNALS, stageClosure, stageAppMirror, trimOnnxruntime, treeBytes } from './sidecar.mjs';
import {
  APP_ANCHOR_REL,
  PACKAGE_JSON_MIRRORS,
  artifactName,
  binaryRelPath,
  splitTarget,
  versionFile,
} from './layout.mjs';
import { assertSizeBudget, mb } from './size.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SEA_DIR = path.join(HERE, 'sea');

const log = (msg) => console.log(msg);

/** Where the official runtime downloads are cached between builds. Never inside the repo. */
function runtimeCacheDir() {
  return path.join(os.tmpdir(), 'wigolo-node-runtimes');
}

/**
 * nodejs.org's own spelling of a target, which is NOT ours: it says `win` where the whole rest
 * of this codebase (and `process.platform`) says `win32`. Kept as a translation in one function
 * rather than a second target vocabulary.
 */
function nodeArchiveName(target, version) {
  const { platform, arch } = splitTarget(target);
  return platform === 'win32'
    ? `node-v${version}-win-${arch}.zip`
    : `node-v${version}-${platform}-${arch}.tar.gz`;
}

function nodeBinaryRelPath(target, version) {
  const { platform, arch } = splitTarget(target);
  return platform === 'win32'
    ? path.join(`node-v${version}-win-${arch}`, 'node.exe')
    : path.join(`node-v${version}-${platform}-${arch}`, 'bin', 'node');
}

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * Fetch and verify the official runtime for `target`.
 *
 * THE DIGEST CHECK IS NOT CEREMONY. This is the one input the artifact cannot be audited
 * without: the bytes of the interpreter every user will run. `runtime.json` records the
 * nodejs.org digests measured by the spike, and a mismatch fails the build rather than
 * warning — a runtime you cannot identify is worse than no build.
 */
async function fetchRuntime({ manifest, target }) {
  const version = manifest.runtime.version;
  const archive = nodeArchiveName(target, version);
  const expected = manifest.runtimeTarballSha256?.[target];
  if (!expected) {
    throw new Error(`REFUSED — runtime.json has no runtimeTarballSha256 entry for ${target}`);
  }

  const cache = runtimeCacheDir();
  fs.mkdirSync(cache, { recursive: true });
  const archivePath = path.join(cache, archive);

  if (!fs.existsSync(archivePath) || sha256File(archivePath) !== expected) {
    const url = `https://nodejs.org/dist/v${version}/${archive}`;
    log(`  downloading ${url}`);
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status} ${res.statusText}`);
    fs.writeFileSync(archivePath, Buffer.from(await res.arrayBuffer()));
  }

  const actual = sha256File(archivePath);
  if (actual !== expected) {
    throw new Error(
      `REFUSED — ${archive} sha256 ${actual} does not match runtime.json's ${expected}.\n` +
        '  The embedded runtime is the one input this artifact cannot be audited without.'
    );
  }

  const binRel = nodeBinaryRelPath(target, version);
  const extractedBin = path.join(cache, binRel);
  if (!fs.existsSync(extractedBin)) {
    // Relative name with `cwd`, never absolute with `-C`: on Windows, PATH resolves `tar` to
    // GNU tar from Git for Windows, which reads `C:\...` as a `host:path` remote spec. The
    // same shape `harvest.mjs` already relies on.
    if (archive.endsWith('.zip')) {
      execFileSync('unzip', ['-qo', archive], { cwd: cache, stdio: ['ignore', 'ignore', 'pipe'] });
    } else {
      execFileSync('tar', ['-xzf', archive], { cwd: cache, stdio: ['ignore', 'ignore', 'pipe'] });
    }
  }
  if (!fs.existsSync(extractedBin)) {
    throw new Error(`REFUSED — ${archive} extracted without ${binRel}`);
  }

  log(`  runtime  node v${version} ${target} (sha256 verified)`);
  return { archivePath, binPath: extractedBin, rootDir: path.join(cache, path.dirname(path.dirname(binRel))) };
}

/**
 * esbuild the shipped dist entry into one CommonJS file, wrapped in the SEA shims.
 *
 * ENTRY IS `dist/index.js`, NOT `src/index.ts`, so the thing compiled is the thing that ships
 * and no tsconfig resolution enters the picture.
 *
 * `--supported:dynamic-import=false` is load-bearing and not an optimization: it lowers every
 * `import()` to `require()`, which is the only reason a bare specifier reaches the sidecar at
 * all. Left on, esbuild emits the `import()` verbatim, it resolves against the process CWD at
 * runtime, and the packaged binary loses the TLS tier, the stealth driver, direct CDP, `sharp`
 * and `fastembed` — silently, with a green build.
 */
function bundle({ workDir, manifest }) {
  const entry = path.join(REPO_ROOT, 'dist', 'index.js');
  if (!fs.existsSync(entry)) {
    log('  dist/index.js absent — running `npm run build` first');
    execFileSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
  }

  const outfile = path.join(workDir, 'bundle.cjs');
  const metafile = path.join(workDir, 'bundle-meta.json');
  const esbuild = path.join(REPO_ROOT, 'node_modules', '.bin', 'esbuild');
  if (!fs.existsSync(esbuild)) throw new Error(`REFUSED — esbuild not installed at ${esbuild}; run \`npm ci\``);

  const banner = fs.readFileSync(path.join(SEA_DIR, 'banner.js'), 'utf8');
  const footer = fs.readFileSync(path.join(SEA_DIR, 'footer.js'), 'utf8');

  execFileSync(
    esbuild,
    [
      entry,
      '--bundle',
      '--platform=node',
      '--format=cjs',
      `--target=node${manifest.runtime.version.split('.')[0]}`,
      `--outfile=${outfile}`,
      `--metafile=${metafile}`,
      `--banner:js=${banner}`,
      `--footer:js=${footer}`,
      '--define:import.meta.url=__wigoloMetaUrl',
      '--define:import.meta.filename=__filename',
      '--define:import.meta.dirname=__dirname',
      '--supported:dynamic-import=false',
      '--log-level=warning',
      ...EXTERNALS.map((e) => `--external:${e.name}`),
    ],
    { cwd: workDir, stdio: ['ignore', 'inherit', 'inherit'] }
  );

  log(`  bundled  ${path.basename(outfile)} (${mb(fs.statSync(outfile).size)})`);
  return { outfile, metafile };
}

/**
 * Every external specifier the ENTRY CLOSURE is known to reach, and which must therefore still
 * be visible in the bundle's own import list.
 *
 * THIS HALF OF THE GATE CATCHES THE SILENT LOSS, and it is the half that is easy to leave out.
 * A surviving `import()` at least fails loudly at runtime. A specifier that a bundler DROPS —
 * which is what happens to `import(SOME_VARIABLE)` — leaves no import at all: no error, no
 * warning, and a capability that is simply absent from the binary and present in every test.
 * Asserting these are still THERE is the only check that sees it.
 *
 * The list is deliberately not "all 16 externals": `onnxruntime-node`, `@napi-rs/keyring`,
 * `playwright-core` and `yoga-layout` are reached THROUGH other externals, so they legitimately
 * never appear in the entry bundle's import list. They ride in the sidecar closure instead, and
 * the M2 smoke arms are what prove they load.
 */
const REQUIRED_BUNDLE_IMPORTS = Object.freeze([
  '@huggingface/transformers',
  'better-sqlite3',
  'chrome-remote-interface',
  'fastembed',
  'ink',
  'patchright',
  'pdf-parse',
  'playwright',
  'sharp',
  'sqlite-vec',
  'wreq-js',
]);

/**
 * Audit the bundle through esbuild's OWN parse, not through a text search.
 *
 * A regex over 10 MB of generated JavaScript cannot tell a dynamic import from the string
 * `"import("` inside an error message — the first attempt at this gate reported nine hits, all
 * nine of them inside string literals or this file's own comments. The metafile is produced by
 * the parser that did the bundling, so it answers the question exactly.
 *
 * @param {object} metafile esbuild `--metafile` JSON
 * @param {readonly string[]} required specifiers that must still be imported
 */
export function auditBundleImports(metafile, required = REQUIRED_BUNDLE_IMPORTS) {
  const dynamic = [];
  const present = new Set();
  for (const output of Object.values(metafile.outputs ?? {})) {
    for (const imp of output.imports ?? []) {
      if (imp.kind === 'dynamic-import') dynamic.push(imp.path);
      present.add(imp.path);
    }
  }
  return { dynamic: [...new Set(dynamic)].sort(), missing: required.filter((r) => !present.has(r)) };
}

function assertBundleImports(metafilePath) {
  const audit = auditBundleImports(JSON.parse(fs.readFileSync(metafilePath, 'utf8')));

  if (audit.dynamic.length > 0) {
    throw new Error(
      `REFUSED — ${audit.dynamic.length} dynamic import(s) survived bundling. Inside a SEA these ` +
        'resolve against the process CWD and fail, removing a capability from the binary only:\n  ' +
        `${audit.dynamic.join('\n  ')}\n` +
        '  --supported:dynamic-import=false should have lowered these to require().'
    );
  }

  if (audit.missing.length > 0) {
    throw new Error(
      `REFUSED — ${audit.missing.length} expected specifier(s) are absent from the bundle's import list:\n  ` +
        `${audit.missing.join('\n  ')}\n` +
        '  A dropped specifier is the SILENT failure: no error at build time, no error at run time,\n' +
        '  just a capability that is missing from the binary. The usual cause is an `import()` whose\n' +
        '  specifier became a variable — spell it inline (see src/fetch/browser-driver.ts).'
    );
  }

  log(`  gate     0 surviving dynamic imports; all ${REQUIRED_BUNDLE_IMPORTS.length} expected specifiers present`);
}

/** `node --experimental-sea-config` — the blob, which is platform-agnostic. */
function buildBlob({ workDir, bundlePath, manifest }) {
  const blob = path.join(workDir, 'sea-prep.blob');
  const config = path.join(workDir, 'sea-config.json');
  fs.writeFileSync(
    config,
    `${JSON.stringify(
      {
        main: path.basename(bundlePath),
        output: path.basename(blob),
        // Silences the "SEA is experimental" notice. It does NOT silence the limited-`require`
        // warning, which is separate, always on, and on stderr — see `banner.js`.
        disableExperimentalSEAWarning: true,
        // Deliberately absent: `useCodeCache`. It buys ~20% startup for +1.3 MB, but the cache
        // is silently REJECTED at runtime when the building arch differs from the running one
        // ("Code cache data rejected", then a quiet recompile). Turning it on therefore means
        // one build host per target, which is BIN-4's decision to make, not this slice's.
      },
      null,
      2
    )}\n`
  );
  execFileSync(process.execPath, ['--experimental-sea-config', path.basename(config)], {
    cwd: workDir,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  log(`  blob     ${path.basename(blob)} (${mb(fs.statSync(blob).size)}), runtime ABI ${manifest.runtime.abi}`);
  return blob;
}

/**
 * Copy the official runtime to `bin/wigolo` and inject the blob.
 *
 * DARWIN NEEDS BOTH SIGNATURE STEPS. postject rewrites the Mach-O, which invalidates the stock
 * signature, and an arm64 Mach-O with an INVALID signature will not execute at all — so the
 * sequence is strip, inject, ad-hoc re-sign. Ad-hoc rather than Developer ID because no signing
 * credentials exist (DR-4); the layout is already the one a real signing pass can walk
 * file-by-file, which is one of the reasons DR-2 chose a sidecar over self-extraction.
 */
function seal({ stageRoot, target, runtimeBin, blob, manifest }) {
  const { platform } = splitTarget(target);
  const dest = path.join(stageRoot, binaryRelPath(platform));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(runtimeBin, dest);
  fs.chmodSync(dest, 0o755);

  if (platform === 'darwin') {
    execFileSync('codesign', ['--remove-signature', dest], { stdio: ['ignore', 'ignore', 'pipe'] });
  }

  const postjectArgs = [
    '-y',
    `postject@${manifest.toolchain.postject}`,
    dest,
    'NODE_SEA_BLOB',
    blob,
    '--sentinel-fuse',
    manifest.toolchain.seaFuse,
  ];
  // Two argv elements, never one string. A `--macho-segment-name NODE_SEA` passed as a single
  // argument is rejected as an unknown option, and the spike recorded that specifically so the
  // log would not be misread as a platform limitation.
  if (platform === 'darwin') postjectArgs.push('--macho-segment-name', 'NODE_SEA');

  execFileSync('npx', postjectArgs, { stdio: ['ignore', 'inherit', 'pipe'] });

  if (platform === 'darwin') {
    execFileSync('codesign', ['-s', '-', dest], { stdio: ['ignore', 'ignore', 'pipe'] });
  }

  log(`  sealed   ${binaryRelPath(platform)} (${mb(fs.statSync(dest).size)})`);
  return dest;
}

/**
 * `LICENSES/` — mini-spec 4's fourth top-level entry, and the one with a legal rather than a
 * technical reason to exist. The artifact redistributes an official Node build and ~150 npm
 * packages; nearly every one of those licenses requires the text to travel with the binary.
 *
 * A package with no license file is RECORDED as such rather than skipped. "We found none" and
 * "there is none" read identically in an empty directory, and only one of them is a problem.
 */
function stageLicenses({ stageRoot, runtimeRoot, packages, manifest }) {
  const root = path.join(stageRoot, 'LICENSES');
  fs.mkdirSync(root, { recursive: true });

  const index = [`wigolo binary artifact — third-party licenses`, ''];

  const repoLicense = path.join(REPO_ROOT, 'LICENSE');
  if (fs.existsSync(repoLicense)) {
    fs.copyFileSync(repoLicense, path.join(root, 'wigolo-LICENSE'));
    index.push('wigolo -> wigolo-LICENSE');
  }

  const nodeLicense = path.join(runtimeRoot, 'LICENSE');
  if (fs.existsSync(nodeLicense)) {
    fs.copyFileSync(nodeLicense, path.join(root, 'node-LICENSE'));
    index.push(`node v${manifest.runtime.version} (embedded runtime) -> node-LICENSE`);
  } else {
    index.push(`node v${manifest.runtime.version} (embedded runtime) -> NO LICENSE FILE IN THE OFFICIAL ARCHIVE`);
  }

  index.push('', 'third-party/ (sidecar packages):');
  const thirdParty = path.join(root, 'third-party');
  for (const pkg of packages) {
    const found = fs
      .readdirSync(pkg.dir, { withFileTypes: true })
      .filter((e) => e.isFile() && /^(LICEN[CS]E|COPYING|NOTICE)/i.test(e.name))
      .map((e) => e.name)
      .sort();
    // Keyed on the package's POSITION, not its name. The closure legitimately contains two
    // copies of the same package at different versions (npm's own answer to a version
    // conflict), and a name-keyed directory would silently keep one license for both.
    const slot = pkg.rel.split(`node_modules${path.sep}`).filter(Boolean).join(path.sep);
    if (found.length === 0) {
      index.push(`  ${slot}@${pkg.version} -> NO LICENSE FILE IN THE PUBLISHED PACKAGE`);
      continue;
    }
    const dest = path.join(thirdParty, slot);
    fs.mkdirSync(dest, { recursive: true });
    for (const name of found) fs.copyFileSync(path.join(pkg.dir, name), path.join(dest, name));
    index.push(`  ${slot}@${pkg.version} -> third-party/${slot}/${found.join(', ')}`);
  }

  fs.writeFileSync(path.join(root, 'INDEX.txt'), `${index.join('\n')}\n`);
  log(`  licenses ${packages.length} sidecar package(s) + the embedded runtime`);
}

/** Accountable size terms: the executable, the app mirror, and each sidecar package. */
function sizeTerms(stageRoot) {
  const terms = [];
  for (const rel of ['bin', 'libexec/app', 'LICENSES']) {
    const p = path.join(stageRoot, rel);
    if (fs.existsSync(p)) terms.push({ name: rel, bytes: treeBytes(p) });
  }
  const modules = path.join(stageRoot, 'libexec', 'node_modules');
  if (fs.existsSync(modules)) {
    for (const entry of fs.readdirSync(modules, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('@')) {
        for (const scoped of fs.readdirSync(path.join(modules, entry.name), { withFileTypes: true })) {
          if (!scoped.isDirectory()) continue;
          const name = `${entry.name}/${scoped.name}`;
          terms.push({ name, bytes: treeBytes(path.join(modules, entry.name, scoped.name)) });
        }
        continue;
      }
      terms.push({ name: entry.name, bytes: treeBytes(path.join(modules, entry.name)) });
    }
  }
  return terms;
}

/** The whole pipeline for one target. Exported so a test can drive it without the CLI. */
export async function buildTarget({ target, outDir, manifest = readManifest(), keepStage = false }) {
  const { platform } = splitTarget(target);
  const semver = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version;

  const workDir = path.resolve(outDir);
  const stageRoot = path.join(workDir, 'wigolo');
  fs.rmSync(stageRoot, { recursive: true, force: true });
  fs.mkdirSync(stageRoot, { recursive: true });

  log(`building wigolo ${semver} for ${target}`);
  log(`  workdir  ${workDir}`);

  const runtime = await fetchRuntime({ manifest, target });
  const { outfile: bundlePath, metafile } = bundle({ workDir, manifest });
  assertBundleImports(metafile);
  const blob = buildBlob({ workDir, bundlePath, manifest });
  seal({ stageRoot, target, runtimeBin: runtime.binPath, blob, manifest });

  // Sidecar BEFORE harvest — see the file header. The harvest must be the last writer of every
  // native path or refuse-don't-compile is decorative.
  const packages = stageClosure({ repoRoot: REPO_ROOT, stageRoot });
  log(`  sidecar  ${packages.length} package(s) staged into libexec/node_modules`);

  stageAppMirror({ repoRoot: REPO_ROOT, stageRoot, mirrors: PACKAGE_JSON_MIRRORS, semver });
  const anchor = path.join(stageRoot, APP_ANCHOR_REL);
  fs.mkdirSync(path.dirname(anchor), { recursive: true });
  fs.writeFileSync(
    anchor,
    '// Not executed. This path is the anchor the embedded bundle reports as `import.meta.url`\n' +
      '// and `__filename`, so that the three package.json depth walks in src/ land on the\n' +
      '// mirrored copies beside it. See scripts/binary/sea/banner.js.\n'
  );
  log(`  mirror   libexec/app (package.json at ${PACKAGE_JSON_MIRRORS.length} depths, assets/, skills/)`);

  const lock = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package-lock.json'), 'utf8'));
  const harvest = await harvestTarget({ manifest, lock, target, stageRoot, log: (m) => log(`  ${m}`) });
  // `harvest-manifest.json` is provenance, and mini-spec 4's top level has exactly four
  // entries — so it moves inside `libexec/`, which the contract declares opaque.
  fs.renameSync(
    path.join(stageRoot, 'harvest-manifest.json'),
    path.join(stageRoot, 'libexec', 'harvest-manifest.json')
  );

  const trim = trimOnnxruntime({ stageRoot, target });
  const trimmed = trim.removed.reduce((n, r) => n + r.bytes, 0);
  log(`  trim     ${trim.reason}${trimmed ? ` (${mb(trimmed)} removed)` : ''}`);

  stageLicenses({ stageRoot, runtimeRoot: runtime.rootDir, packages, manifest });

  fs.writeFileSync(path.join(stageRoot, 'VERSION'), versionFile({ semver, target, manifest }));

  const archive = artifactName(semver, target);
  const archivePath = path.join(workDir, archive);
  fs.rmSync(archivePath, { force: true });
  if (platform === 'win32') {
    execFileSync('zip', ['-qry', archive, 'wigolo'], { cwd: workDir, stdio: ['ignore', 'ignore', 'inherit'] });
  } else {
    execFileSync('tar', ['-czf', archive, 'wigolo'], { cwd: workDir, stdio: ['ignore', 'ignore', 'inherit'] });
  }

  const unpackedBytes = treeBytes(stageRoot);
  const compressedBytes = fs.statSync(archivePath).size;
  const verdict = assertSizeBudget({ compressedBytes, unpackedBytes, terms: sizeTerms(stageRoot) });

  log('');
  log(`ARTIFACT ${archivePath}`);
  log(`  compressed ${mb(compressedBytes)}   unpacked ${mb(unpackedBytes)}`);
  log(`  sha256     ${sha256File(archivePath)}`);
  log(`  top terms  ${verdict.ranked.slice(0, 3).map((t) => `${t.name} ${mb(t.bytes)}`).join(', ')}`);

  if (!keepStage) log(`  unpacked tree kept at ${stageRoot}`);
  return { archivePath, stageRoot, compressedBytes, unpackedBytes, semver, target, packages };
}

function parseArgs(argv) {
  const opts = { target: `${process.platform}-${process.arch}`, out: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const [flag, inline] = eq === -1 ? [arg, null] : [arg.slice(0, eq), arg.slice(eq + 1)];
    const value = () => inline ?? argv[++i];
    if (flag === '--target') opts.target = value();
    else if (flag === '--out') opts.out = value();
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const manifest = readManifest();
  if (!manifest.targets.includes(opts.target)) {
    throw new Error(`REFUSED — ${opts.target} is not one of runtime.json's targets: ${manifest.targets.join(', ')}`);
  }
  const outDir = opts.out ?? path.join(os.tmpdir(), `wigolo-binary-build-${opts.target}`);
  await buildTarget({ target: opts.target, outDir, manifest });
}

// `fileURLToPath`, never `new URL(url).pathname` — the pathname is URL-ENCODED, so a checkout
// under `~/My Projects/` never compares equal and `main()` silently does not run. Same guard,
// same reason, as `harvest.mjs`.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`\n${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
}
