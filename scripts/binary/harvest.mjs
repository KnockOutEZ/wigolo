#!/usr/bin/env node
/*
 * Harvest the official prebuilt natives for one target and stage them into `libexec/`.
 *
 * REFUSE, DON'T COMPILE (mini-spec DR-3). There is no source-build fallback in this file, and
 * that absence is the feature: a silent `node-gyp` rebuild is how an ABI-mismatched or
 * unredistributable native ships looking green, which is the SD-234-1 class this whole
 * milestone exists to close. A missing cell fails the run and names the cell.
 *
 * WHAT A CELL IS. One (native x target) artifact: `better-sqlite3` for `darwin-arm64`,
 * `@img/sharp-libvips-linux-x64`, the `bin/napi-v3/win32/x64` slice of `onnxruntime-node`.
 * The mapping from a native and a target to a URL and a staging path is `cells.mjs`, which is
 * pure; this file does the I/O and the assertions.
 *
 * THE FOUR ASSERTIONS, and the failure each one closes:
 *
 *   1. Upstream integrity, where upstream publishes one. Every npm cell is checked against
 *      the `integrity` sha512 in OUR `package-lock.json` — an upstream-published digest we
 *      already trust for `npm ci`. `better-sqlite3`'s GitHub release assets have no published
 *      digest; that is recorded as `integrityVerified: false` with the reason, never silently
 *      skipped, because "no checksum" and "checksum passed" must not read the same downstream.
 *   2. Payload present. A staged cell must contain at least one loadable object
 *      (`.node`/`.dylib`/`.so*`/`.dll`). Without this, a wrong `extract.from` stages an empty
 *      directory and the run reports a complete artifact that cannot open a database.
 *   3. Version == lockfile, from the artifact's own metadata. The npm tarball's
 *      `package/package.json` version is compared to the lockfile entry the URL came from, so
 *      a mis-resolved or registry-substituted tarball is caught rather than staged.
 *   4. No drift, across runs. `versionDrift()` re-checks the recorded manifest against the
 *      lockfile as it is NOW, which is the only non-circular form of the check: it catches a
 *      staging dir or manifest produced before a dependency bump.
 *
 * OPTIONALS DEGRADE, THEY DO NOT FAIL. `@napi-rs/keyring` and `wreq-js` already degrade
 * cleanly under npm, and must degrade identically here: an optional cell that upstream does
 * not publish for a target is recorded as `status: "absent"` with the reason, and the run
 * still succeeds. A non-optional cell in the same state is a refusal. The manifest is where
 * the absence is visible, so a build cannot lose a tier without saying so.
 *
 * Usage:
 *   node scripts/binary/harvest.mjs --target darwin-arm64
 *   node scripts/binary/harvest.mjs --target linux-x64 --out /tmp/stage
 *   node scripts/binary/harvest.mjs --all-targets --resolve-only
 *   node scripts/binary/harvest.mjs --verify-drift /tmp/stage/harvest-manifest.json
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readManifest, REPO_ROOT } from './manifest.mjs';
import { resolveCells, versionDrift } from './cells.mjs';

const PAYLOAD_EXT = /\.(node|dylib|dll)$|\.so(\.\d+)*$/;

/** Loadable-object files under `dir`, relative paths, sorted. */
function payloadFiles(dir) {
  const found = [];
  const walk = (rel) => {
    const abs = path.join(dir, rel);
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const next = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) walk(next);
      else if (entry.isFile() && PAYLOAD_EXT.test(entry.name)) found.push(next);
    }
  };
  if (fs.existsSync(dir)) walk('');
  return found.sort();
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * Extract `<dir>/<name>` in place.
 *
 * Named RELATIVELY with `cwd`, never absolute with `-C`: on a Windows runner PATH resolves
 * `tar` to GNU tar from Git for Windows, which reads `C:\...` as a `host:path` remote spec.
 * The same shape `scripts/verify-better-sqlite3-prebuild.mjs` already relies on.
 */
function untar(dir, name) {
  execFileSync('tar', ['-xzf', name], { stdio: ['ignore', 'ignore', 'pipe'], cwd: dir });
}

/** Default network fetch. Injectable so every unit test runs with no socket at all. */
async function httpDownload(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status} ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * `subresource-integrity` style check against the lockfile's digest.
 * @returns {{ ok: boolean, expected: string, actual: string }}
 */
export function checkIntegrity(bytes, integrity) {
  const dash = integrity.indexOf('-');
  const algo = integrity.slice(0, dash);
  const expected = integrity.slice(dash + 1);
  const actual = createHash(algo).update(bytes).digest('base64');
  return { ok: actual === expected, expected: integrity, actual: `${algo}-${actual}` };
}

/** npm tarballs root everything at `package/`; a GitHub release asset roots at its own paths. */
function tarballRoot(cell) {
  return cell.source.kind === 'npm-tarball' ? 'package' : '';
}

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  fs.cpSync(from, to, { recursive: true, dereference: true });
}

/**
 * The message a refusal carries. Names the cell, the target, and why there is no fallback.
 */
function refusal(cell, reason) {
  const abi = cell.source?.abi ? `, node ABI ${cell.source.abi}` : '';
  return (
    `REFUSED cell ${cell.id} — ${cell.native} for ${cell.target}${abi}: ${reason}\n` +
    '  no source-build fallback exists in this pipeline (mini-spec DR-3): a silent compile is how\n' +
    '  an ABI-mismatched or unredistributable native ships looking green.'
  );
}

/**
 * Fetch, verify and stage one cell.
 *
 * @returns {object} the manifest record for the cell
 * @throws when a NON-optional cell cannot be completed; the message is `refusal()`
 */
async function harvestCell({ cell, stageRoot, workRoot, download, log }) {
  const record = {
    id: cell.id,
    native: cell.native,
    pkg: cell.pkg,
    version: cell.version,
    target: cell.target,
    optional: cell.optional,
    abiKind: cell.abiKind,
    napiVersion: cell.napiVersion ?? null,
    status: 'absent',
    source: cell.source,
    stageTo: cell.stageTo,
    payload: [],
    absence: null,
  };

  const decline = (reason) => {
    if (!cell.optional) throw new Error(refusal(cell, reason));
    record.absence = { reason };
    log(`   absent  ${cell.id} — ${reason} (optional: recorded, build continues)`);
    return record;
  };

  if (cell.unresolvable) return decline(cell.unresolvable);

  const work = path.join(workRoot, cell.id.replace(/[^A-Za-z0-9._@-]+/g, '_'));
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });

  let bytes;
  try {
    bytes = await download(cell.source.url);
  } catch (err) {
    return decline(String(err?.message ?? err));
  }

  const archive = path.join(work, 'artifact.tar.gz');
  fs.writeFileSync(archive, bytes);

  let integrityVerified = false;
  if (cell.source.integrity) {
    const check = checkIntegrity(bytes, cell.source.integrity);
    if (!check.ok) {
      // Never optional-degrade a checksum failure: a wrong-bytes artifact is not an absent
      // one, and continuing would stage bytes nobody vouched for.
      throw new Error(
        refusal(cell, `integrity mismatch — lockfile says ${check.expected}, downloaded bytes are ${check.actual}`)
      );
    }
    integrityVerified = true;
  }

  try {
    untar(work, 'artifact.tar.gz');
  } catch (err) {
    return decline(`tar could not read the downloaded artifact: ${String(err?.message ?? err).split('\n')[0]}`);
  }

  const root = path.join(work, tarballRoot(cell));

  // Assertion 3 — the artifact's own metadata against the lockfile entry the URL came from.
  if (cell.source.kind === 'npm-tarball') {
    const pkgJson = path.join(root, 'package.json');
    if (!fs.existsSync(pkgJson)) {
      return decline('npm tarball extracted without package/package.json');
    }
    const staged = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
    if (staged.version !== cell.version) {
      throw new Error(
        refusal(cell, `version drift — package-lock.json pins ${cell.version}, the downloaded tarball is ${staged.version}`)
      );
    }
  }

  const dest = path.join(stageRoot, 'libexec', cell.stageTo);
  if (cell.extract.mode === 'file') {
    const src = path.join(root, cell.extract.from);
    if (!fs.existsSync(src)) return decline(`artifact contains no ${cell.extract.from}`);
    fs.mkdirSync(dest, { recursive: true });
    fs.copyFileSync(src, path.join(dest, path.basename(cell.extract.from)));
  } else if (cell.extract.mode === 'subdir') {
    const src = path.join(root, cell.extract.from);
    if (!fs.existsSync(src)) return decline(`artifact contains no ${cell.extract.from}/`);
    copyTree(src, dest);
  } else {
    copyTree(root, dest);
  }

  // Assertion 2 — something loadable actually landed.
  const payload = payloadFiles(dest);
  if (payload.length === 0) {
    const where = cell.extract.from ? `${cell.extract.from} ` : '';
    throw new Error(refusal(cell, `staged ${where}but it contains no loadable object (.node/.dylib/.so/.dll)`));
  }

  record.status = 'staged';
  record.source = { ...cell.source, integrityVerified };
  record.payload = payload.map((rel) => ({
    path: rel,
    bytes: fs.statSync(path.join(dest, rel)).size,
    sha256: sha256(path.join(dest, rel)),
  }));
  log(`  staged  ${cell.id} -> libexec/${cell.stageTo} (${payload.length} object${payload.length === 1 ? '' : 's'}${integrityVerified ? ', integrity verified' : ', no upstream digest'})`);
  return record;
}

/**
 * Harvest every cell one target needs into `stageRoot`, and write `harvest-manifest.json`.
 *
 * Every dependency the tests need to control is a parameter: `download` so no unit test opens
 * a socket, `lock` so a drift arm can hand in an edited copy, `stageRoot`/`workRoot` so
 * nothing is written inside the repo.
 */
export async function harvestTarget({
  manifest,
  lock,
  target,
  stageRoot,
  workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wigolo-harvest-')),
  download = httpDownload,
  log = () => {},
}) {
  const cells = resolveCells({ manifest, lock, target });
  log(`target ${target} — ${cells.length} cells, runtime ${manifest.runtime.kind} ${manifest.runtime.version} (ABI ${manifest.runtime.abi}, NAPI ${manifest.runtime.napi})`);

  const records = [];
  for (const cell of cells) {
    records.push(await harvestCell({ cell, stageRoot, workRoot, download, log }));
  }

  const doc = {
    schema: 'wigolo-binary-harvest/1',
    target,
    runtime: manifest.runtime,
    generatedAt: new Date().toISOString(),
    cells: records,
    absent: records.filter((r) => r.status === 'absent').map((r) => ({ id: r.id, native: r.native, reason: r.absence.reason })),
  };

  fs.mkdirSync(stageRoot, { recursive: true });
  fs.writeFileSync(path.join(stageRoot, 'harvest-manifest.json'), `${JSON.stringify(doc, null, 2)}\n`);

  // Assertion 4 — belt and braces within the same run, and the exported check BIN-3 re-runs
  // before it compiles anything against a staging dir it did not create.
  const drift = versionDrift(doc, lock);
  if (drift.length > 0) {
    throw new Error(`REFUSED — harvested versions no longer match package-lock.json:\n  ${drift.join('\n  ')}`);
  }

  return doc;
}

/** Cells only, no I/O — how "does every target resolve?" is answered without a network. */
export function describeTarget({ manifest, lock, target }) {
  const cells = resolveCells({ manifest, lock, target });
  return cells.map((cell) => ({
    id: cell.id,
    native: cell.native,
    target,
    optional: cell.optional,
    url: cell.source?.url ?? null,
    stageTo: cell.stageTo,
    unresolvable: cell.unresolvable ?? null,
  }));
}

function parseArgs(argv) {
  const opts = { target: null, allTargets: false, out: null, resolveOnly: false, verifyDrift: null, lockfile: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const [flag, inlineValue] = eq === -1 ? [arg, null] : [arg.slice(0, eq), arg.slice(eq + 1)];
    const value = () => inlineValue ?? argv[++i];
    if (flag === '--all-targets') opts.allTargets = true;
    else if (flag === '--resolve-only') opts.resolveOnly = true;
    else if (flag === '--target') opts.target = value();
    else if (flag === '--out') opts.out = value();
    else if (flag === '--verify-drift') opts.verifyDrift = value();
    else if (flag === '--lockfile') opts.lockfile = value();
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const manifest = readManifest();
  const lockPath = opts.lockfile ?? path.join(REPO_ROOT, 'package-lock.json');
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));

  if (opts.verifyDrift) {
    const doc = JSON.parse(fs.readFileSync(opts.verifyDrift, 'utf8'));
    const drift = versionDrift(doc, lock);
    if (drift.length > 0) {
      console.error(`DRIFT — ${opts.verifyDrift} does not match ${lockPath}:\n  ${drift.join('\n  ')}`);
      process.exitCode = 1;
      return;
    }
    console.log(`no drift — every cell in ${opts.verifyDrift} matches ${lockPath}`);
    return;
  }

  const targets = opts.allTargets ? [...manifest.targets] : [opts.target];
  if (targets.some((t) => !t)) {
    throw new Error('--target <platform>-<arch> is required (or --all-targets)');
  }

  if (opts.resolveOnly) {
    let unresolved = 0;
    for (const target of targets) {
      const rows = describeTarget({ manifest, lock, target });
      console.log(`\n${target} — ${rows.length} cells`);
      for (const row of rows) {
        const mark = row.unresolvable ? (row.optional ? 'absent ' : 'MISSING') : 'ok     ';
        if (row.unresolvable && !row.optional) unresolved++;
        console.log(`  ${mark} ${row.id}${row.unresolvable ? ` — ${row.unresolvable}` : ` -> libexec/${row.stageTo}`}`);
      }
    }
    if (unresolved > 0) {
      console.error(`\nREFUSED — ${unresolved} non-optional cell(s) unresolvable (mini-spec DR-3)`);
      process.exitCode = 1;
    }
    return;
  }

  for (const target of targets) {
    const stageRoot = path.resolve(opts.out ?? path.join(os.tmpdir(), `wigolo-binary-stage-${target}`));
    fs.rmSync(path.join(stageRoot, 'libexec'), { recursive: true, force: true });
    const doc = await harvestTarget({ manifest, lock, target, stageRoot, log: (m) => console.log(m) });
    const staged = doc.cells.filter((c) => c.status === 'staged').length;
    console.log(
      `\nHARVESTED ${target} — ${staged}/${doc.cells.length} cells staged into ${stageRoot}/libexec` +
        (doc.absent.length > 0 ? `; ${doc.absent.length} optional cell(s) absent: ${doc.absent.map((a) => a.native).join(', ')}` : '')
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch((err) => {
    console.error(`\n${err?.message ?? err}`);
    process.exitCode = 1;
  });
}
