/*
 * The load-verify battery — mini-spec §2 M1/M2/M3, §4 G1/G5, §6's darwin signature and §7's
 * budget — run against an artifact that is ALREADY BUILT, on the platform it was built for.
 *
 * WHY THIS EXISTS AS A SCRIPT AND NOT ONLY AS A TEST. §3's sentence is the whole point of the
 * release matrix: "an artifact that never opened a DB on its own platform does not ship". The
 * artifact for linux-arm64 is built on a darwin host, so the only thing that can honour that
 * sentence is a program that runs on a linux-arm64 machine with nothing but the archive and a
 * Node interpreter — no repo install, no vitest, no `npm ci`. Everything here is Node builtins
 * plus two pure sibling modules for exactly that reason.
 *
 * THE FIRST ARM IS A REFUSAL, and it is the one that makes cross-compiling honest: if
 * `process.platform`-`process.arch` does not equal the target the artifact's own `VERSION` file
 * claims, the battery refuses to run at all. A YAML label can be edited to point a verify job at
 * the wrong runner; the machine it actually landed on cannot. This is the check that turns "we
 * verify on a platform-native runner" from a promise about a workflow file into a property of
 * the verification itself (§3, counter-review finding 2).
 *
 * `tests/integration/binary-artifact.test.ts` imports the probe and handshake from here rather
 * than carrying copies: the artifact arms and the CI arms must be the same arms, or the suite
 * green stops meaning the release is verifiable.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { binaryRelPath, parseVersionFile, splitTarget, SIZE_BUDGET } from './layout.mjs';
import { checkSizeBudget, mb, sizeBudgetFailure } from './size.mjs';
import { treeBytes } from './sidecar.mjs';

/** The ten tools an MCP client must see. A short list, spelled out, so a lost tool is a diff. */
export const EXPECTED_TOOLS = Object.freeze([
  'agent',
  'cache',
  'crawl',
  'diff',
  'extract',
  'fetch',
  'find_similar',
  'research',
  'search',
  'watch',
]);

export const HOST_TARGET = `${process.platform}-${process.arch}`;

/**
 * The native + mechanism probe, as source.
 *
 * Written into the artifact's ANCHOR DIRECTORY and run through the binary's own `--run-script`
 * verb, so the run itself is the M3 spawn-reentry arm. The anchor is where the embedded bundle
 * reports itself to be, so a probe placed there resolves modules through exactly the path the
 * bundle's own `require`s take — a probe run from a scratch directory would prove that some
 * `require` works, not that the binary's does.
 */
export const PROBE_SOURCE = `
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { Worker } = require('node:worker_threads');
const out = {};
const t = (name, fn) => { try { out[name] = { ok: true, ...fn() }; } catch (e) { out[name] = { ok: false, error: String((e && e.message) || e).slice(0, 300) }; } };

t('better_sqlite3', () => {
  const Database = require('better-sqlite3');
  const f = path.join(os.tmpdir(), 'wigolo-smoke-' + process.pid + '.db');
  const db = new Database(f);
  db.exec('CREATE TABLE t(a INTEGER, b TEXT)');
  db.prepare('INSERT INTO t VALUES (?,?)').run(7, 'seven');
  const row = db.prepare('SELECT * FROM t').get();
  const sqlite = db.prepare('SELECT sqlite_version() AS v').get().v;
  db.close(); fs.rmSync(f, { force: true });
  return { row, sqlite };
});

t('sqlite_vec', () => {
  const Database = require('better-sqlite3');
  const sv = require('sqlite-vec');
  const f = path.join(os.tmpdir(), 'wigolo-smoke-vec-' + process.pid + '.db');
  const db = new Database(f);
  sv.load(db);
  const version = db.prepare('SELECT vec_version() AS v').get().v;
  db.exec('CREATE VIRTUAL TABLE v USING vec0(embedding float[4])');
  // BigInt for the rowid: better-sqlite3 binds a plain JS number as REAL, and vec0 accepts only
  // integer primary keys. src/cache/sqlite-vec-store.ts does the same, for the same reason.
  const f32 = (a) => Buffer.from(new Float32Array(a).buffer);
  const ins = db.prepare('INSERT INTO v(rowid, embedding) VALUES (?, ?)');
  ins.run(BigInt(1), f32([1, 0, 0, 0]));
  ins.run(BigInt(3), f32([0.9, 0.1, 0, 0]));
  const hits = db.prepare('SELECT rowid, distance FROM v WHERE embedding MATCH ? ORDER BY distance LIMIT 2').all(f32([1, 0, 0, 0]));
  const loadable = sv.getLoadablePath();
  db.close(); fs.rmSync(f, { force: true });
  return { version, hits, loadable };
});

t('keyring', () => ({ exports: Object.keys(require('@napi-rs/keyring')).sort() }));
t('transformers', () => {
  const m = require('@huggingface/transformers');
  return { has: ['pipeline', 'AutoTokenizer', 'env'].filter((n) => n in m) };
});
t('wreq', () => {
  const w = require('wreq-js');
  return { hasFetch: typeof (w.fetch || (w.default && w.default.fetch)) === 'function' };
});

// M3 — EXTERNAL-BINARY-SPAWN. 33 of the 40 spawn sites in src/ are this class. The command is
// per-platform because the class is "a real executable on this OS", and there is no one such
// executable on all five targets.
t('m3_external_spawn', () => {
  if (process.platform === 'win32') {
    const cmd = path.join(process.env.SystemRoot || 'C:\\\\Windows', 'System32', 'cmd.exe');
    return { probe: execFileSync(cmd, ['/c', 'ver']).toString().trim().slice(0, 120) };
  }
  const uname = fs.existsSync('/usr/bin/uname') ? '/usr/bin/uname' : '/bin/uname';
  return { probe: execFileSync(uname, ['-sm']).toString().trim() };
});
// The guard every packaging branch in src/ is keyed on. False here means those branches are dead.
t('sea_detected', () => ({ isSea: require('node:sea').isSea() }));

(async () => {
  try {
    const sharp = require('sharp');
    const png = await sharp({ create: { width: 32, height: 24, channels: 3, background: { r: 1, g: 2, b: 3 } } })
      .resize(16, 12).png().toBuffer();
    const meta = await sharp(png).metadata();
    out.sharp = { ok: true, bytes: png.length, w: meta.width, h: meta.height, fmt: meta.format };
  } catch (e) { out.sharp = { ok: false, error: String((e && e.message) || e).slice(0, 300) }; }

  // M3 — WORKER. \`new Worker(process.execPath)\` cannot work in a SEA (Node parses the 118 MB
  // executable as JavaScript source), so the mechanism that DOES work is the one pinned here.
  // src/ has zero worker sites today; this arm is what makes the answer exist before one lands.
  try {
    const src = "const{parentPort}=require('node:worker_threads');parentPort.postMessage({from:'eval-worker'});";
    const got = await new Promise((res, rej) => {
      const w = new Worker(src, { eval: true });
      w.once('message', (m) => { res(m); w.terminate(); });
      w.once('error', rej);
      setTimeout(() => rej(new Error('worker timeout')), 20000);
    });
    out.m3_eval_worker = { ok: true, ...got };
  } catch (e) { out.m3_eval_worker = { ok: false, error: String((e && e.message) || e).slice(0, 300) }; }

  process.stdout.write('PROBE_JSON ' + JSON.stringify(out) + '\\n');
})();
`;

/** Where the probe file goes: the anchor directory, inside the artifact. */
export const PROBE_REL = path.join('libexec', 'app', 'dist', 'cli', 'tui', '__smoke-probe.cjs');

/**
 * Spawn the artifact and collect BOTH streams as bytes.
 *
 * Both, not just stdout: byte counts on stdout are the M1 gate, and `warmup`'s human-readable
 * report goes to stderr — an arm that read only stdout compared against an empty string and
 * would have passed for a binary that printed nothing at all.
 */
export function runBinary(exe, args, { dataDir, timeout = 120_000 } = {}) {
  const r = spawnSync(exe, args, {
    env: { ...process.env, WIGOLO_DATA_DIR: dataDir },
    timeout,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(
      `${path.basename(exe)} ${args.join(' ')} exited ${r.status}\n${r.stderr?.toString('utf8').slice(-2000) ?? ''}`
    );
  }
  return { stdout: r.stdout, stderr: r.stderr };
}

/**
 * The M1b probe: a full MCP stdio handshake, reassembled from raw bytes.
 *
 * Byte-cleanliness is the gate and it is stricter than "the JSON parsed". A single stray byte on
 * stdout — a banner, a stray `console.log`, a progress bar — corrupts JSON-RPC framing for every
 * client, so the assertion is that the summed JSON-RPC byte count EQUALS the total stdout byte
 * count, not merely that the messages could be found among the noise.
 */
export function mcpHandshake(exe, { dataDir } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, ['mcp'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, WIGOLO_DATA_DIR: dataDir },
    });
    let out = Buffer.alloc(0);
    child.stdout.on('data', (d) => {
      out = Buffer.concat([out, d]);
    });
    child.stderr.resume();
    child.on('error', reject);

    const send = (o) => child.stdin.write(`${JSON.stringify(o)}\n`);
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'binary-smoke', version: '0' },
      },
    });

    setTimeout(() => {
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    }, 1500);

    setTimeout(() => {
      child.kill();
      const dirty = [];
      const messages = [];
      let jsonBytes = 0;
      for (const line of out.toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.jsonrpc !== '2.0') throw new Error('not jsonrpc');
          messages.push(parsed);
          jsonBytes += Buffer.byteLength(line, 'utf8') + 1;
        } catch {
          dirty.push(line.slice(0, 200));
        }
      }
      resolve({
        stdoutBytes: out.length,
        jsonBytes,
        dirty,
        tools: (messages.find((m) => m.id === 2)?.result?.tools ?? []).map((t) => t.name),
        serverVersion: messages.find((m) => m.id === 1)?.result?.serverInfo?.version,
      });
    }, 12_000);
  });
}

/** Write the probe into the artifact's anchor dir and run it through `--run-script`. */
export function runProbe(exe, root, { dataDir } = {}) {
  const probe = path.join(root, PROBE_REL);
  fs.mkdirSync(path.dirname(probe), { recursive: true });
  fs.writeFileSync(probe, PROBE_SOURCE);
  const stdout = runBinary(exe, ['--run-script', probe], { dataDir, timeout: 300_000 }).stdout.toString('utf8');
  const line = stdout.split('\n').find((l) => l.startsWith('PROBE_JSON '));
  if (!line) throw new Error(`probe produced no PROBE_JSON line; stdout was:\n${stdout.slice(0, 2000)}`);
  return JSON.parse(line.slice('PROBE_JSON '.length));
}

export function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * Unpack an artifact archive into `dest`, returning the `wigolo/` root inside it.
 *
 * `tar` for a tarball on unix, and `tar -xf` for the zip ON WINDOWS ONLY — Windows ships bsdtar,
 * which reads zip; GNU tar on linux does not, and the zip only exists for the win32 target, so
 * the one place a zip is ever unpacked is the one place `tar` can do it. Relative archive name
 * with `cwd`, never absolute with `-C`: GNU tar reads `C:\...` as a `host:path` remote spec, the
 * same shape `harvest.mjs` and `build.mjs` already rely on.
 */
export function unpackArtifact(archive, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const name = path.basename(archive);
  const staged = path.join(dest, name);
  fs.copyFileSync(archive, staged);
  if (name.endsWith('.zip')) {
    execFileSync('tar', ['-xf', name], { cwd: dest, stdio: ['ignore', 'ignore', 'inherit'] });
  } else {
    execFileSync('tar', ['-xzf', name], { cwd: dest, stdio: ['ignore', 'ignore', 'inherit'] });
  }
  fs.rmSync(staged, { force: true });
  const root = path.join(dest, 'wigolo');
  if (!fs.existsSync(root)) {
    throw new Error(`${name} unpacked without a top-level wigolo/ dir (mini-spec §4 layout)`);
  }
  return root;
}

/**
 * Run the whole battery against an unpacked artifact root.
 *
 * Returns a list of arms rather than throwing on the first failure: a release engineer reading a
 * red verify job needs to know whether ONE native is missing or the binary never started, and a
 * battery that stops at arm 1 cannot tell them. The caller decides what a failure means.
 *
 * @param {{ root: string, target: string, expectSemver?: string, dataDir: string, embeddings?: boolean, archive?: string }} input
 */
export async function runBattery({ root, target, expectSemver, dataDir, embeddings = true, archive }) {
  const checks = [];
  const arm = (name, fn) => {
    const started = Date.now();
    try {
      const detail = fn();
      checks.push({ name, ok: true, detail: detail ?? null, ms: Date.now() - started });
      return detail;
    } catch (err) {
      checks.push({
        name,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        ms: Date.now() - started,
      });
      return null;
    }
  };

  const { platform } = splitTarget(target);
  const exe = path.join(root, binaryRelPath(platform));

  const version = arm('§4 G5 · VERSION', () => {
    const parsed = parseVersionFile(fs.readFileSync(path.join(root, 'VERSION'), 'utf8'));
    if (parsed.target !== target) {
      throw new Error(`VERSION says target=${parsed.target}, this verify lane is for ${target}`);
    }
    if (expectSemver && parsed.semver !== expectSemver) {
      throw new Error(`VERSION says semver=${parsed.semver}, expected ${expectSemver}`);
    }
    return parsed;
  });
  const semver = version?.semver ?? expectSemver;

  arm('§4 layout · four top-level entries', () => {
    const missing = ['bin', 'libexec', 'LICENSES', 'VERSION'].filter(
      (entry) => !fs.existsSync(path.join(root, entry))
    );
    if (missing.length > 0) throw new Error(`missing: ${missing.join(', ')}`);
    if (!fs.existsSync(exe)) throw new Error(`no executable at ${binaryRelPath(platform)}`);
    return { entries: 4 };
  });

  // §6 — the darwin signature. postject invalidates the stock one and an arm64 Mach-O with an
  // INVALID signature does not execute at all, so this arm is upstream of every other darwin arm:
  // if it fails, everything after it fails too and the cause is here.
  arm('§6 · darwin ad-hoc signature', () => {
    if (platform !== 'darwin') return { skipped: `not applicable on ${platform}` };
    const r = spawnSync('codesign', ['-v', '--verbose=2', exe], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`codesign -v exited ${r.status}: ${(r.stderr || '').trim()}`);
    return { codesign: (r.stderr || '').trim().split('\n').slice(0, 2).join(' | ') };
  });

  arm('M1a · --version byte-exact', () => {
    const out = runBinary(exe, ['--version'], { dataDir }).stdout.toString('utf8');
    if (out !== `wigolo ${semver}\n`) {
      throw new Error(`stdout was ${JSON.stringify(out)}, expected ${JSON.stringify(`wigolo ${semver}\n`)}`);
    }
    return { bytes: Buffer.byteLength(out, 'utf8') };
  });

  const handshake = await mcpHandshake(exe, { dataDir }).catch((err) => ({ error: String(err) }));
  arm('M1b · MCP handshake byte-clean', () => {
    if (handshake.error) throw new Error(handshake.error);
    if (handshake.dirty.length > 0) throw new Error(`dirty stdout lines: ${handshake.dirty.length}`);
    if (handshake.jsonBytes !== handshake.stdoutBytes) {
      throw new Error(`${handshake.stdoutBytes} stdout bytes vs ${handshake.jsonBytes} JSON-RPC bytes`);
    }
    const tools = [...handshake.tools].sort();
    if (tools.join(',') !== [...EXPECTED_TOOLS].join(',')) {
      throw new Error(`tools/list returned ${tools.length}: ${tools.join(', ')}`);
    }
    if (handshake.serverVersion !== semver) {
      throw new Error(`serverInfo.version is ${handshake.serverVersion}, expected ${semver}`);
    }
    return { stdoutBytes: handshake.stdoutBytes, tools: tools.length, serverVersion: handshake.serverVersion };
  });

  let probe = null;
  arm('M2/M3 · probe runs through --run-script', () => {
    probe = runProbe(exe, root, { dataDir });
    return { arms: Object.keys(probe).length };
  });

  arm('M2 · every native loads and works', () => {
    if (!probe) throw new Error('probe did not run');
    const failed = Object.entries(probe)
      .filter(([, v]) => !v.ok)
      .map(([k, v]) => `${k}: ${v.error}`);
    if (failed.length > 0) throw new Error(failed.join('; '));
    if (probe.better_sqlite3.row?.b !== 'seven') {
      throw new Error(`better-sqlite3 returned ${JSON.stringify(probe.better_sqlite3.row)}`);
    }
    if (probe.sqlite_vec.version !== 'v0.1.9') throw new Error(`sqlite-vec ${probe.sqlite_vec.version}`);
    // A kNN ANSWER, not just a loaded extension: a wrong-ABI or half-staged extension can load
    // and then return nothing.
    if (probe.sqlite_vec.hits?.length !== 2 || probe.sqlite_vec.hits[0].distance !== 0) {
      throw new Error(`vec0 kNN returned ${JSON.stringify(probe.sqlite_vec.hits)}`);
    }
    // Relocatable by construction: the extension is loaded from inside the artifact, not from an
    // absolute build-host path, which is the other half of the M2 gate.
    if (!String(probe.sqlite_vec.loadable).includes(path.join('libexec', 'node_modules'))) {
      throw new Error(`sqlite-vec loaded from outside the artifact: ${probe.sqlite_vec.loadable}`);
    }
    if (probe.sharp.w !== 16 || probe.sharp.h !== 12 || probe.sharp.fmt !== 'png') {
      throw new Error(`sharp produced ${JSON.stringify(probe.sharp)}`);
    }
    return {
      sqlite: probe.better_sqlite3.sqlite,
      vec: probe.sqlite_vec.version,
      sharpBytes: probe.sharp.bytes,
      keyring: probe.keyring.exports.length,
      transformers: probe.transformers.has.length,
      wreq: probe.wreq.hasFetch,
    };
  });

  arm('M3 · one arm per mechanism class', () => {
    if (!probe) throw new Error('probe did not run');
    // SPAWN-REENTRY: getting a PROBE_JSON line back at all IS that arm passing — unfixed, the
    // child reads the script path as an unknown subcommand and prints the help text.
    if (!probe.m3_eval_worker.ok || probe.m3_eval_worker.from !== 'eval-worker') {
      throw new Error(`eval worker: ${JSON.stringify(probe.m3_eval_worker)}`);
    }
    if (!probe.m3_external_spawn.ok) throw new Error(`external spawn: ${probe.m3_external_spawn.error}`);
    // Every packaging branch in src/ is keyed on this. False, and they are all dead code inside
    // the one artifact they exist for.
    if (probe.sea_detected.isSea !== true) throw new Error('node:sea.isSea() is false inside the artifact');
    return {
      spawnReentry: 'ok',
      externalSpawn: probe.m3_external_spawn.probe,
      evalWorker: probe.m3_eval_worker.from,
      isSea: true,
    };
  });

  if (embeddings) {
    arm('M2 · embedding model through the real CLI route', () => {
      // The only route that drives onnxruntime-node end to end, and the one that caught the
      // sidecar's flattened-dependency defect: a nested tar@7 shadowing the hoisted tar@6 killed
      // this deep inside a dependency while every other native stayed green.
      const r = runBinary(exe, ['warmup', '--embeddings', '--plain'], { dataDir, timeout: 900_000 });
      const out = `${r.stdout.toString('utf8')}${r.stderr.toString('utf8')}`;
      if (!/embeddings model .* ready/.test(out)) throw new Error(out.slice(-600));
      return { route: 'warmup --embeddings' };
    });
  }

  arm('§4 G1 · relocatable from a second path', () => {
    const moved = path.join(path.dirname(root), 'relocated', 'wigolo-elsewhere');
    fs.rmSync(path.dirname(moved), { recursive: true, force: true });
    fs.mkdirSync(path.dirname(moved), { recursive: true });
    fs.cpSync(root, moved, { recursive: true, dereference: false });
    const movedExe = path.join(moved, binaryRelPath(platform));
    if (platform !== 'win32') fs.chmodSync(movedExe, 0o755);
    const out = runBinary(movedExe, ['--version'], { dataDir }).stdout.toString('utf8');
    if (out !== `wigolo ${semver}\n`) throw new Error(`relocated binary said ${JSON.stringify(out)}`);

    // The symlink arm separates `realpathSync(process.execPath)` from `dirname(process.execPath)`.
    // install.sh puts exactly this shape on PATH, and its parent directory contains no `libexec`
    // at all. Skipped on win32, where creating one needs Developer Mode or elevation — a runner
    // capability, not a property of the artifact.
    if (platform === 'win32') return { relocated: true, symlink: 'skipped on win32' };
    const link = path.join(path.dirname(root), 'wigolo-link');
    fs.rmSync(link, { force: true });
    fs.symlinkSync(movedExe, link);
    const viaLink = runBinary(link, ['--version'], { dataDir }).stdout.toString('utf8');
    if (viaLink !== `wigolo ${semver}\n`) throw new Error(`symlinked binary said ${JSON.stringify(viaLink)}`);
    return { relocated: true, symlink: true };
  });

  arm('§7 · size budget, both axes', () => {
    const unpackedBytes = treeBytes(root);
    const compressedBytes = archive ? fs.statSync(archive).size : 0;
    if (!archive) return { unpacked: mb(unpackedBytes), compressed: 'not measured (no archive)' };
    const verdict = checkSizeBudget({ compressedBytes, unpackedBytes });
    if (!verdict.ok) throw new Error(sizeBudgetFailure(verdict));
    return {
      compressed: mb(compressedBytes),
      unpacked: mb(unpackedBytes),
      limits: `${mb(SIZE_BUDGET.compressedBytes)} / ${mb(SIZE_BUDGET.unpackedBytes)}`,
    };
  });

  return { target, semver, checks, failed: checks.filter((c) => !c.ok) };
}

/**
 * The refusal that makes the platform-native claim checkable.
 *
 * A verify job's runner label lives in YAML and can be edited; the machine the job actually
 * landed on cannot. §3 forbids downgrading a target's verify to a build-host smoke, so the
 * battery refuses to run anywhere but on the artifact's own platform and arch.
 */
export function assertHostIsTarget(target) {
  if (HOST_TARGET !== target) {
    throw new Error(
      `REFUSED — this host is ${HOST_TARGET}, the artifact is for ${target}.\n` +
        '  mini-spec §3: load-verify runs on a PLATFORM-NATIVE runner. Verifying a foreign target ' +
        'here would be the build-host smoke the spec forbids, not a workaround for a missing lane.'
    );
  }
  return target;
}

function parseArgs(argv) {
  const opts = { archive: null, dir: null, target: null, semver: null, json: null, embeddings: true };
  for (let i = 0; i < argv.length; i++) {
    const eq = argv[i].indexOf('=');
    const [flag, inline] = eq === -1 ? [argv[i], null] : [argv[i].slice(0, eq), argv[i].slice(eq + 1)];
    const value = () => inline ?? argv[++i];
    if (flag === '--artifact') opts.archive = value();
    else if (flag === '--dir') opts.dir = value();
    else if (flag === '--target') opts.target = value();
    else if (flag === '--expect-semver') opts.semver = value();
    else if (flag === '--json') opts.json = value();
    else if (flag === '--no-embeddings') opts.embeddings = false;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!opts.archive && !opts.dir) throw new Error('one of --artifact <archive> or --dir <unpacked wigolo/> is required');
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  // The scratch tree goes under the OS temp dir, never beside the archive: a verify job is handed
  // an artifact, not a workspace, and unpacking 400 MB into a checkout is how a later step ends up
  // measuring the verifier's own leftovers.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'wigolo-verify-'));
  const dataDir = path.join(work, 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  let root = opts.dir;
  if (opts.archive) root = unpackArtifact(path.resolve(opts.archive), path.join(work, 'unpacked'));

  const declared = parseVersionFile(fs.readFileSync(path.join(root, 'VERSION'), 'utf8'));
  const target = opts.target ?? declared.target;
  if (opts.target && opts.target !== declared.target) {
    throw new Error(
      `REFUSED — asked to verify ${opts.target} but the artifact's VERSION says ${declared.target}. ` +
        'A mismatched pair means the wrong archive reached this lane.'
    );
  }
  assertHostIsTarget(target);

  process.stdout.write(`verifying ${path.basename(opts.archive ?? root)} on ${HOST_TARGET}\n`);
  const digest = opts.archive ? sha256File(path.resolve(opts.archive)) : null;
  if (digest) process.stdout.write(`  sha256 ${digest}\n`);

  const result = await runBattery({
    root,
    target,
    expectSemver: opts.semver,
    dataDir,
    embeddings: opts.embeddings,
    archive: opts.archive ? path.resolve(opts.archive) : undefined,
  });

  process.stdout.write('\n');
  for (const check of result.checks) {
    const status = check.ok ? 'PASS' : 'FAIL';
    const body = check.ok ? JSON.stringify(check.detail) : check.error.split('\n')[0];
    process.stdout.write(`  ${status}  ${check.name} — ${body}\n`);
  }

  if (opts.json) {
    fs.writeFileSync(
      opts.json,
      `${JSON.stringify({ ...result, host: HOST_TARGET, sha256: digest, artifact: opts.archive ? path.basename(opts.archive) : null }, null, 2)}\n`
    );
  }

  if (result.failed.length > 0) {
    process.stdout.write(
      `\nVERIFY FAILED — ${result.failed.length} of ${result.checks.length} arm(s) red on ${HOST_TARGET}:\n`
    );
    for (const f of result.failed) process.stdout.write(`  ${f.name}\n    ${f.error.split('\n').join('\n    ')}\n`);
    process.stdout.write(
      '\nmini-spec §3: this artifact does not ship. An artifact that never opened a DB on its own\n' +
        'platform does not ship, and a failed arm is not downgradable to a warning.\n'
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`\nVERIFY OK — ${result.checks.length} arms green for ${target} on ${HOST_TARGET}\n`);
  fs.rmSync(work, { recursive: true, force: true });
}

// `fileURLToPath`, never `new URL(url).pathname` — the pathname is URL-encoded, so a checkout
// under a directory with a space never compares equal and `main()` silently does not run.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`\n${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
