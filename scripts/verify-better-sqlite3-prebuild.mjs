#!/usr/bin/env node
/**
 * Verify that a PUBLISHED better-sqlite3 prebuild asset genuinely loads, and that the
 * native surface it exposes actually works.
 *
 * Loading is not the bar. A `require()` that returns an object only proves a file
 * resolved; it does not prove the extension's SQLite build carries FTS5, which is the
 * one compile-time option wigolo's cache cannot run without. So every positive run
 * builds an FTS5 index and drives a `MATCH` through it, and asserts a non-matching
 * query returns nothing — a MATCH that returns every row is not a MATCH.
 *
 * The asset is downloaded from the release, not taken from `node_modules`: the point is
 * to verify the artifact users receive, on the platform they receive it for. The JS
 * wrapper is unpacked straight from the registry tarball, so no install lifecycle runs and
 * nothing can quietly compile a fresh binding and verify itself.
 *
 * Usage:
 *   node scripts/verify-better-sqlite3-prebuild.mjs                       # host target
 *   node scripts/verify-better-sqlite3-prebuild.mjs --target win32-arm64
 *   node scripts/verify-better-sqlite3-prebuild.mjs --target linux-x64 --expect-fail
 *   node scripts/verify-better-sqlite3-prebuild.mjs --abi 115 --expect-fail
 *   node scripts/verify-better-sqlite3-prebuild.mjs --missing-binding --expect-fail
 *
 * `--expect-fail` inverts the exit code, but only over the LOAD. Download and extract
 * must still succeed: a control that "passes" because the asset 404'd would prove the
 * URL was wrong, not that the binding was rejected.
 */

import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const opts = { target: null, abi: null, expectFail: false, missingBinding: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--expect-fail') opts.expectFail = true;
    else if (arg === '--missing-binding') opts.missingBinding = true;
    else if (arg === '--target') opts.target = argv[++i];
    else if (arg === '--abi') opts.abi = argv[++i];
    else if (arg.startsWith('--target=')) opts.target = arg.slice('--target='.length);
    else if (arg.startsWith('--abi=')) opts.abi = arg.slice('--abi='.length);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

/** The pin is the lockfile's, never a literal here — a version bump must not silently
 *  leave this probe verifying the previous release. */
function lockedPackage() {
  const lockPath = path.join(REPO_ROOT, 'package-lock.json');
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  const entry = lock.packages?.['node_modules/better-sqlite3'];
  if (!entry?.version || !entry.resolved || !entry.integrity) {
    throw new Error(`no complete "node_modules/better-sqlite3" entry in ${lockPath}`);
  }
  return { version: entry.version, resolved: entry.resolved, integrity: entry.integrity };
}

function assetName(version, abi, target) {
  return `better-sqlite3-v${version}-node-v${abi}-${target}.tar.gz`;
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status} ${res.statusText}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, bytes);
  return bytes.length;
}

/**
 * The JS wrapper, unpacked straight from the registry tarball the lockfile resolves to and
 * checked against the lockfile's integrity hash.
 *
 * `npm install` is deliberately not used. It would need `npm.cmd` on Windows, which Node
 * refuses to spawn without `shell: true` (the CVE-2024-27980 hardening) — the same trap
 * that made `tests/e2e/init-command.e2e.test.ts` spawn a child that never started. Beyond
 * dodging that, unpacking directly means no install lifecycle exists at all, so neither
 * prebuild-install nor node-gyp can supply a binding and let this probe verify itself. The
 * wrapper's only non-relative dependency is `bindings`, which `lib/database.js` requires
 * lazily and only when `nativeBinding` is null — this probe always passes it a path.
 */
async function fetchWrapper(pkg, dir) {
  const wrapperDir = path.join(dir, 'package');
  if (fs.existsSync(path.join(wrapperDir, 'lib', 'database.js'))) return wrapperDir;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const tarball = path.join(dir, 'wrapper.tgz');
  await download(pkg.resolved, tarball);

  const [algo, expected] = pkg.integrity.split('-');
  const actual = createHash(algo).update(fs.readFileSync(tarball)).digest('base64');
  if (actual !== expected) {
    throw new Error(`${pkg.resolved} ${algo} is ${algo}-${actual}, lockfile says ${pkg.integrity}`);
  }

  execFileSync('tar', ['-xzf', tarball, '-C', dir], { stdio: 'inherit' });
  if (!fs.existsSync(path.join(wrapperDir, 'lib', 'database.js'))) {
    throw new Error(`registry tarball extracted without package/lib/database.js in ${dir}`);
  }
  return wrapperDir;
}

function driveFts5(Database, bindingPath) {
  const db = new Database(':memory:', { nativeBinding: bindingPath });
  try {
    const sqliteVersion = db.prepare('SELECT sqlite_version() AS v').get().v;
    db.exec('CREATE VIRTUAL TABLE docs USING fts5(title, body)');
    const insert = db.prepare('INSERT INTO docs (title, body) VALUES (?, ?)');
    insert.run('prebuild-under-test', 'the published asset carries a working fts5 module');
    insert.run('unrelated-row', 'nothing here should answer the query below');
    insert.run('second-unrelated-row', 'nor should this one');

    const hits = db
      .prepare('SELECT title FROM docs WHERE docs MATCH ? ORDER BY rank')
      .all('fts5');
    const titles = hits.map((r) => r.title);
    if (titles.length !== 1 || titles[0] !== 'prebuild-under-test') {
      throw new Error(`MATCH returned ${JSON.stringify(titles)}, expected ["prebuild-under-test"]`);
    }

    // A MATCH that answers everything is indistinguishable from a table scan.
    const misses = db.prepare('SELECT title FROM docs WHERE docs MATCH ?').all('nonexistentterm');
    if (misses.length !== 0) {
      throw new Error(`non-matching MATCH returned ${misses.length} rows, expected 0`);
    }
    return { sqliteVersion, titles };
  } finally {
    db.close();
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const pkg = lockedPackage();
  const version = pkg.version;
  const abi = opts.abi ?? process.versions.modules;
  const target = opts.target ?? `${process.platform}-${process.arch}`;
  const hostTarget = `${process.platform}-${process.arch}`;

  const work = path.join(os.tmpdir(), `bs3-prebuild-probe-${abi}-${target}`);
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });

  const wrapperDir = await fetchWrapper(pkg, path.join(os.tmpdir(), 'bs3-prebuild-wrapper'));

  console.log(`better-sqlite3 version : ${version} (from package-lock.json)`);
  console.log(`host                   : node ${process.version} / ${hostTarget} / ABI ${process.versions.modules}`);
  console.log(`target under test      : ${target} / ABI ${abi}`);
  console.log(`wrapper (no install lifecycle): ${wrapperDir}`);

  let bindingPath;
  if (opts.missingBinding) {
    bindingPath = path.join(work, 'build', 'Release', 'better_sqlite3.node');
    console.log(`binding                : ${bindingPath} (deliberately absent)`);
    if (fs.existsSync(bindingPath)) throw new Error('the "missing" binding exists — control is void');
  } else {
    const name = assetName(version, abi, target);
    const url = `https://github.com/WiseLibs/better-sqlite3/releases/download/v${version}/${name}`;
    const tarball = path.join(work, name);
    const bytes = await download(url, tarball);
    execFileSync('tar', ['-xzf', tarball, '-C', work], { stdio: 'inherit' });
    bindingPath = path.join(work, 'build', 'Release', 'better_sqlite3.node');
    if (!fs.existsSync(bindingPath)) {
      throw new Error(`${name} extracted without build/Release/better_sqlite3.node`);
    }
    const sha = createHash('sha256').update(fs.readFileSync(bindingPath)).digest('hex');
    console.log(`asset                  : ${name} (${bytes} bytes)`);
    console.log(`asset url              : ${url}`);
    console.log(`binding                : ${bindingPath}`);
    console.log(`binding sha256         : ${sha}`);
  }

  const require = createRequire(import.meta.url);
  const Database = require(wrapperDir);

  let result = null;
  let failure = null;
  try {
    result = driveFts5(Database, bindingPath);
  } catch (err) {
    failure = err;
  }

  if (opts.expectFail) {
    if (failure) {
      console.log(`\nNEGATIVE CONTROL HELD — ${target} / ABI ${abi} was REJECTED on ${hostTarget}`);
      console.log(`  rejection: ${String(failure.message).split('\n')[0]}`);
      return;
    }
    console.error(
      `\nNEGATIVE CONTROL FAILED — ${target} / ABI ${abi} LOADED and ran FTS5 on ${hostTarget}.` +
        ' A control that cannot fail proves nothing about the positive runs beside it.'
    );
    process.exitCode = 1;
    return;
  }

  if (failure) throw failure;
  console.log(`sqlite                 : ${result.sqliteVersion}`);
  console.log(`fts5 MATCH             : ${JSON.stringify(result.titles)}`);
  console.log(`\nVERIFIED — ${target} prebuild loaded and served an FTS5 MATCH on ${hostTarget}`);
}

main().catch((err) => {
  console.error(`\nFAILED — ${err?.stack ?? err}`);
  process.exitCode = 1;
});
