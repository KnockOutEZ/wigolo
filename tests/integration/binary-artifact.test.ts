import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allowNetworkInThisFile } from '../net-fence.js';
// @ts-expect-error — plain-JS build tooling, deliberately not part of the typed src/ graph.
import { buildTarget } from '../../scripts/binary/build.mjs';
// @ts-expect-error — plain-JS build tooling, deliberately not part of the typed src/ graph.
import { parseVersionFile, SIZE_BUDGET } from '../../scripts/binary/layout.mjs';

/*
 * THE SMOKE ARMS, RUN AGAINST THE REAL ARTIFACT — mini-spec §2 M1, M2 and M3, plus §4 G1
 * relocation and the §7 size budget.
 *
 * WHY OPT-IN. This builds a ~120 MB binary: it downloads an official Node runtime, harvests six
 * natives from five registries and a GitHub release, and stages a ~180-package sidecar. On an
 * ordinary run it would report other people's outages as our red — the same reason
 * `tests/unit/binary/harvest-live.test.ts` is opt-in — and it takes minutes, not seconds. Set
 * `WIGOLO_BINARY_BUILD=1` to run it. Everything that can be decided WITHOUT the artifact is in
 * `tests/unit/binary/compile-pipeline.test.ts` and runs on every suite.
 *
 * WHY THE ARMS ARE WHAT THEY ARE. M1 and M2 alone NEVER FORK. A broken process-model site —
 * a spawn that re-enters wigolo instead of running the script it was handed — passes both of
 * them and then fails the first time a user asks for a browser, months later, with a message
 * that reads like a network error. So there is one arm per M3 mechanism class, exercised from
 * inside the artifact: a spawn-reentry site, a worker site, and an external-binary spawn.
 *
 * THE NATIVE PROBE RUNS FROM THE ANCHOR DIRECTORY, not from a scratch path, and that is not a
 * convenience. The anchor is where the embedded bundle reports itself to be, so a probe placed
 * there resolves modules through EXACTLY the path the bundle's own requires take. A probe run
 * from elsewhere would prove that some `require` works, not that the binary's does.
 */

allowNetworkInThisFile(
  'builds the real single-binary artifact: downloads the official Node runtime from nodejs.org and ' +
    'harvests prebuilt natives from npm and a GitHub release. Opt-in via WIGOLO_BINARY_BUILD=1.'
);

const ENABLED = process.env.WIGOLO_BINARY_BUILD === '1';
const HOST_TARGET = `${process.platform}-${process.arch}`;
const BUILD_TIMEOUT_MS = 20 * 60 * 1000;

let work: string | null = null;
let artifact: { archivePath: string; stageRoot: string; compressedBytes: number; unpackedBytes: number; semver: string } | null = null;
let dataDir = '';
let bin = '';

/**
 * Spawn the artifact and collect BOTH streams as bytes.
 *
 * Both, not just stdout: byte counts on stdout are the M1 gate, and `warmup`'s human-readable
 * report goes to stderr — an arm that read only stdout compared against an empty string and
 * would have passed for a binary that printed nothing at all.
 */
function run(exe: string, args: string[], opts: { timeout?: number } = {}) {
  const r = spawnSync(exe, args, {
    env: { ...process.env, WIGOLO_DATA_DIR: dataDir },
    timeout: opts.timeout ?? 120_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`${exe} ${args.join(' ')} exited ${r.status}\n${r.stderr?.toString('utf8').slice(-2000) ?? ''}`);
  }
  return { stdout: r.stdout as Buffer, stderr: r.stderr as Buffer };
}

/**
 * The M1b probe: a full MCP stdio handshake, reassembled from raw bytes.
 *
 * Byte-cleanliness is the gate and it is stricter than "the JSON parsed". A single stray byte on
 * stdout — a banner, a stray `console.log`, a progress bar — corrupts JSON-RPC framing for every
 * client, so the assertion is that the summed JSON-RPC byte count EQUALS the total stdout byte
 * count, not merely that the messages could be found among the noise.
 */
function mcpHandshake(exe: string): Promise<{ stdoutBytes: number; jsonBytes: number; dirty: string[]; tools: string[]; serverVersion?: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, ['mcp'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, WIGOLO_DATA_DIR: dataDir } });
    let out = Buffer.alloc(0);
    child.stdout.on('data', (d: Buffer) => { out = Buffer.concat([out, d]); });
    child.stderr.resume();
    child.on('error', reject);

    const send = (o: unknown) => child.stdin.write(`${JSON.stringify(o)}\n`);
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'binary-smoke', version: '0' } } });

    setTimeout(() => {
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    }, 1500);

    setTimeout(() => {
      child.kill();
      const dirty: string[] = [];
      const messages: Array<Record<string, any>> = [];
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
        tools: (messages.find((m) => m.id === 2)?.result?.tools ?? []).map((t: { name: string }) => t.name),
        serverVersion: messages.find((m) => m.id === 1)?.result?.serverInfo?.version,
      });
    }, 12_000);
  });
}

/**
 * The native + mechanism probe, as source. Written into the artifact's anchor directory and run
 * through the binary's own `--run-script` verb, so the run itself is the spawn-reentry arm.
 */
const PROBE_SOURCE = `
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

// M3 — EXTERNAL-BINARY-SPAWN. 33 of the 40 spawn sites in src/ are this class.
t('m3_external_spawn', () => ({ uname: execFileSync('/usr/bin/uname', ['-sm']).toString().trim() }));
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

function runProbe(exe: string, stageRoot: string): Record<string, { ok: boolean; error?: string } & Record<string, unknown>> {
  const probe = join(stageRoot, 'libexec', 'app', 'dist', 'cli', 'tui', '__smoke-probe.cjs');
  writeFileSync(probe, PROBE_SOURCE);
  const stdout = run(exe, ['--run-script', probe], { timeout: 300_000 }).stdout.toString('utf8');
  const line = stdout.split('\n').find((l) => l.startsWith('PROBE_JSON '));
  if (!line) throw new Error(`probe produced no PROBE_JSON line; stdout was:\n${stdout.slice(0, 2000)}`);
  return JSON.parse(line.slice('PROBE_JSON '.length));
}

beforeAll(async () => {
  if (!ENABLED) return;
  work = mkdtempSync(join(tmpdir(), 'wigolo-binary-smoke-'));
  dataDir = join(work, 'data');
  mkdirSync(dataDir, { recursive: true });
  artifact = await buildTarget({ target: HOST_TARGET, outDir: work });
  bin = join(artifact!.stageRoot, 'bin', process.platform === 'win32' ? 'wigolo.exe' : 'wigolo');
}, BUILD_TIMEOUT_MS);

afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

describe.runIf(ENABLED)('the built artifact', () => {
  it('has exactly the four top-level entries §4 promises', () => {
    for (const entry of ['bin', 'libexec', 'LICENSES', 'VERSION']) {
      expect({ entry, present: existsSync(join(artifact!.stageRoot, entry)) }).toEqual({ entry, present: true });
    }
  });

  it('VERSION says the same semver as package.json — §4 G5', () => {
    const parsed = parseVersionFile(readFileSync(join(artifact!.stageRoot, 'VERSION'), 'utf8'));
    expect(parsed.semver).toBe(artifact!.semver);
    expect(parsed.target).toBe(HOST_TARGET);
  });

  it('M1a — `--version` is byte-exact on stdout', () => {
    const out = run(bin, ['--version']);
    expect(out.stdout.toString('utf8')).toBe(`wigolo ${artifact!.semver}\n`);
  });

  it('M1b — the MCP handshake is byte-clean and reports the real version', async () => {
    const r = await mcpHandshake(bin);
    expect(r.dirty).toEqual([]);
    // The equality, not just "it parsed": one stray byte on stdout corrupts framing for every
    // MCP client, and the spike's whole M1 gate is this comparison.
    expect(r.jsonBytes).toBe(r.stdoutBytes);
    expect(r.tools.sort()).toEqual(['agent', 'cache', 'crawl', 'diff', 'extract', 'fetch', 'find_similar', 'research', 'search', 'watch']);
    // `0.0.0` here is the spike's silent defect: a raw readFileSync inside a catch, unreachable
    // by any require shim, answering a default to every client while `--version` was right.
    expect(r.serverVersion).toBe(artifact!.semver);
  }, 60_000);

  it('M2 — every native loads and WORKS from inside the artifact', () => {
    const probe = runProbe(bin, artifact!.stageRoot);
    const failed = Object.entries(probe).filter(([, v]) => !v.ok).map(([k, v]) => `${k}: ${v.error}`);
    expect(failed).toEqual([]);

    expect(probe.better_sqlite3.row).toEqual({ a: 7, b: 'seven' });
    expect(probe.sqlite_vec.version).toBe('v0.1.9');
    // A kNN answer, not just a loaded extension: a wrong-ABI or half-staged extension can load
    // and then return nothing.
    expect(probe.sqlite_vec.hits).toEqual([
      { rowid: 1, distance: 0 },
      { rowid: 3, distance: expect.any(Number) },
    ]);
    // Relocatable by construction: the extension is loaded from inside the artifact, not from
    // an absolute build-host path, which is the other half of the M2 gate.
    expect(String(probe.sqlite_vec.loadable)).toContain(join('libexec', 'node_modules'));

    expect(probe.sharp).toMatchObject({ w: 16, h: 12, fmt: 'png' });
    expect(probe.transformers.has).toEqual(['pipeline', 'AutoTokenizer', 'env']);
    expect(probe.wreq.hasFetch).toBe(true);
    expect((probe.keyring.exports as string[]).length).toBeGreaterThan(0);
  }, 300_000);

  it('M3 — one arm per mechanism class, all from inside the artifact', () => {
    const probe = runProbe(bin, artifact!.stageRoot);
    // SPAWN-REENTRY: `--run-script` is how a compiled wigolo runs a foreign JS entrypoint on the
    // runtime it embeds. Getting a PROBE_JSON line back at all IS this arm passing — unfixed,
    // the child reads the script path as an unknown subcommand and prints the help text.
    expect(probe.m3_eval_worker.ok).toBe(true);
    expect(probe.m3_eval_worker.from).toBe('eval-worker');
    expect(probe.m3_external_spawn.ok).toBe(true);
    // Every packaging branch in src/ is keyed on this. False, and they are all dead code inside
    // the one artifact they exist for.
    expect(probe.sea_detected.isSea).toBe(true);
  }, 300_000);

  it('M2 — the embedding model runs through the real CLI route', () => {
    // The only route that drives onnxruntime-node end to end, and the one that caught the
    // sidecar's flattened-dependency defect: a nested tar@7 shadowing the hoisted tar@6 killed
    // this deep inside a dependency while every other native stayed green.
    const r = run(bin, ['warmup', '--embeddings', '--plain'], { timeout: 900_000 });
    const out = `${r.stdout.toString('utf8')}${r.stderr.toString('utf8')}`;
    expect(out).toMatch(/embeddings model .* ready/);
  }, 900_000);

  it('§4 G1 — relocatable: works from a second unpack path and through a symlink', async () => {
    const moved = join(work!, 'relocated', 'wigolo-elsewhere');
    mkdirSync(join(work!, 'relocated'), { recursive: true });
    cpSync(artifact!.stageRoot, moved, { recursive: true, dereference: false });
    const movedBin = join(moved, 'bin', process.platform === 'win32' ? 'wigolo.exe' : 'wigolo');

    expect(run(movedBin, ['--version']).stdout.toString('utf8')).toBe(`wigolo ${artifact!.semver}\n`);

    // The symlink arm is the one that separates `realpathSync(process.execPath)` from
    // `dirname(process.execPath)`. install.sh puts exactly this shape on PATH, and its parent
    // directory contains no `libexec` at all.
    const link = join(work!, 'wigolo-link');
    rmSync(link, { force: true });
    symlinkSync(movedBin, link);
    expect(run(link, ['--version']).stdout.toString('utf8')).toBe(`wigolo ${artifact!.semver}\n`);

    const r = await mcpHandshake(movedBin);
    expect(r.dirty).toEqual([]);
    expect(r.jsonBytes).toBe(r.stdoutBytes);
    expect(r.tools).toHaveLength(10);
  }, 120_000);

  it('§7 — the artifact is inside both halves of the size budget', () => {
    expect(artifact!.compressedBytes).toBeLessThanOrEqual(SIZE_BUDGET.compressedBytes);
    expect(artifact!.unpackedBytes).toBeLessThanOrEqual(SIZE_BUDGET.unpackedBytes);
  });
});
