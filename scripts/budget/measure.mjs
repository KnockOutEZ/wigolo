#!/usr/bin/env node
/*
 * Budget gate runner. One subcommand per gate; exits non-zero when a gate fails.
 *
 *   node scripts/budget/measure.mjs install-size
 *   node scripts/budget/measure.mjs tarball
 *   node scripts/budget/measure.mjs idle-rss
 *   node scripts/budget/measure.mjs cold-start
 *   node scripts/budget/measure.mjs acquire-snapshot <file>   # before `wigolo warmup`
 *   node scripts/budget/measure.mjs acquire-diff <file>       # after it
 *
 * These do not belong in vitest. A unit test cannot perform an install, cannot spawn a real
 * server and watch it settle, and cannot observe what `warmup` downloads — it can only assert
 * over a fixture, and a fixture of an install size is a number someone typed. The reducers
 * (plateau detection, median, the assertion itself) ARE unit-tested; they live in
 * protocol.mjs precisely so they can be.
 *
 * `acquire-*` is split into two invocations because the thing being measured is the delta
 * across a step this script does not own: CI already runs `wigolo warmup` with a specific set
 * of flags, and re-running it here would both double the download and measure a warm cache.
 */
import { execFileSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, copyFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GATES,
  RSS_SAMPLE_INTERVAL_MS,
  RSS_HORIZON_MS,
  RSS_RUNS,
  COLD_START_RUNS,
  floorMiB,
  median,
  evaluate,
  renderReport,
} from './protocol.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DIST_ENTRY = join(ROOT, 'dist', 'index.js');

/** `du -sm` in MiB. A path that does not exist measures 0 rather than throwing. */
function duMiB(path) {
  if (!existsSync(path)) return 0;
  const out = execFileSync('du', ['-sm', path], { encoding: 'utf8' });
  return Number.parseInt(out.trim().split(/\s+/)[0], 10);
}

function report(gateId, measured, detail) {
  const gate = GATES[gateId];
  const { pass } = evaluate(gate, measured);
  console.log(renderReport(gate, measured, { pass, detail }));
  if (!pass) process.exitCode = 1;
  return pass;
}

// ---------------------------------------------------------------- install size

/*
 * Biggest packages, for the log. Purely diagnostic: when G-DIET reds, the next question is
 * always "which package", and the answer should already be in the CI output rather than
 * needing a local reproduction. Best-effort — a failure to enumerate must not fail the gate,
 * because the gate's assertion is the total and that has already been measured.
 */
function largestPackages(modulesDir, stripPrefix) {
  try {
    return execFileSync('sh', ['-c', `du -sm ${JSON.stringify(modulesDir)}/* | sort -rn | head -8`], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .map((l) => l.replace(stripPrefix, '').trim())
      .join(' | ');
  } catch {
    return '(unavailable on this platform)';
  }
}

function measureInstallSize() {
  const dir = mkdtempSync(join(tmpdir(), 'wigolo-budget-'));
  try {
    copyFileSync(join(ROOT, 'package.json'), join(dir, 'package.json'));
    copyFileSync(join(ROOT, 'package-lock.json'), join(dir, 'package-lock.json'));
    execFileSync(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['install', '--omit=dev', '--ignore-scripts', '--no-workspaces', '--no-audit', '--no-fund'],
      {
        cwd: dir,
        stdio: ['ignore', 'ignore', 'inherit'],
        env: {
          ...process.env,
          PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
          ELECTRON_SKIP_BINARY_DOWNLOAD: '1',
        },
      },
    );
    const total = duMiB(join(dir, 'node_modules'));
    return report('G-DIET', total, `largest: ${largestPackages(join(dir, 'node_modules'), dir)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// -------------------------------------------------------------------- tarball

function measureTarball() {
  const out = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const meta = JSON.parse(out)[0];
  const mib = Math.round((meta.unpackedSize / 1048576) * 10) / 10;
  return report('G-TARBALL', mib, `${meta.entryCount} files, ${Math.round(meta.size / 1048576 * 10) / 10} MiB packed`);
}

// ------------------------------------------------------------------- mcp boot

/**
 * Spawn the MCP server and resolve when `initialize` comes back.
 * Resolves the child too, so the RSS gate can keep sampling the same process.
 */
function spawnMcpAndInit(dataDir) {
  const started = Date.now();
  const child = spawn(process.execPath, [DIST_ENTRY, 'mcp'], {
    env: { ...process.env, WIGOLO_DATA_DIR: dataDir },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.resume();
  const ready = new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('no initialize response within 30s')), 30000);
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          if (JSON.parse(line).id === 1) {
            clearTimeout(timer);
            resolve(Date.now() - started);
          }
        } catch {}
      }
    });
    child.once('error', reject);
  });
  child.stdin.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'budget', version: '0' } },
    }) + '\n',
  );
  return { child, ready };
}

function freshDataDir() {
  return mkdtempSync(join(tmpdir(), 'wigolo-budget-data-'));
}

function rssMiB(pid) {
  const out = execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim();
  if (!out) throw new Error(`process ${pid} is gone`);
  return Math.round((Number.parseInt(out, 10) / 1024) * 10) / 10;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One run: sample for the whole fixed horizon, then take the floor. */
async function idleRssFloorOnce() {
  const dataDir = freshDataDir();
  const { child, ready } = spawnMcpAndInit(dataDir);
  try {
    await ready;
    const samples = [];
    const start = Date.now();
    // The horizon is fixed, and the loop does NOT stop early when the series looks flat.
    // Stopping early is the plateau rule, and the plateau rule is what returns a different
    // tread of the staircase every run (protocol.mjs, RSS_HORIZON_MS).
    while (Date.now() - start < RSS_HORIZON_MS) {
      await sleep(RSS_SAMPLE_INTERVAL_MS);
      samples.push({ tMs: Date.now() - start, valueMB: rssMiB(child.pid) });
    }
    return { floor: floorMiB(samples), samples };
  } finally {
    child.kill('SIGKILL');
    rmSync(dataDir, { recursive: true, force: true });
  }
}

async function measureIdleRss() {
  if (process.platform === 'win32') throw new Error('RSS sampling uses `ps`; wire a win32 sampler before gating there');
  const floors = [];
  const traces = [];
  for (let i = 0; i < RSS_RUNS; i++) {
    const { floor, samples } = await idleRssFloorOnce();
    floors.push(floor);
    traces.push(`run${i + 1} floor=${floor} [${samples.map((s) => s.valueMB).join(' ')}]`);
  }
  return report('G-RSS-IDLE', median(floors), traces.join('; '));
}

async function measureColdStart() {
  const runs = [];
  for (let i = 0; i < COLD_START_RUNS; i++) {
    const dataDir = freshDataDir();
    const { child, ready } = spawnMcpAndInit(dataDir);
    try {
      runs.push(await ready);
    } finally {
      child.kill('SIGKILL');
      rmSync(dataDir, { recursive: true, force: true });
    }
  }
  return report('G-COLD-START', median(runs), `runs: ${runs.join(' ')} ms`);
}

// ----------------------------------------------------------- acquired bytes

/**
 * Everywhere `warmup` puts bytes. Enumerated rather than diffed over $HOME so an unrelated
 * cache that happens to grow during the job cannot be charged to warmup.
 */
function acquisitionDirs() {
  const home = homedir();
  const browsers =
    process.env.PLAYWRIGHT_BROWSERS_PATH ||
    (process.platform === 'darwin'
      ? join(home, 'Library', 'Caches', 'ms-playwright')
      : process.platform === 'win32'
        ? join(home, 'AppData', 'Local', 'ms-playwright')
        : join(home, '.cache', 'ms-playwright'));
  return {
    browsers,
    data: process.env.WIGOLO_DATA_DIR || join(home, '.wigolo'),
  };
}

function acquireSnapshot(file) {
  const dirs = acquisitionDirs();
  const snap = Object.fromEntries(Object.entries(dirs).map(([k, p]) => [k, { path: p, mib: duMiB(p) }]));
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify(snap, null, 2));
  console.log(`snapshot: ${Object.entries(snap).map(([k, v]) => `${k}=${v.mib}MiB`).join(' ')}`);
}

function acquireDiff(file) {
  const before = JSON.parse(readFileSync(file, 'utf8'));
  const parts = [];
  let total = 0;
  for (const [key, { path, mib }] of Object.entries(before)) {
    const now = duMiB(path);
    const delta = Math.max(0, now - mib);
    total += delta;
    parts.push(`${key} ${mib}->${now} (+${delta})`);
  }
  return report('G-ACQUIRE', total, parts.join(', '));
}

// ------------------------------------------------------------------ dispatch

const [subcommand, arg] = process.argv.slice(2);
const handlers = {
  'install-size': measureInstallSize,
  tarball: measureTarball,
  'idle-rss': measureIdleRss,
  'cold-start': measureColdStart,
  'acquire-snapshot': () => acquireSnapshot(arg ?? join(ROOT, 'budget-acquire.json')),
  'acquire-diff': () => acquireDiff(arg ?? join(ROOT, 'budget-acquire.json')),
};

const handler = handlers[subcommand];
if (!handler) {
  console.error(`usage: measure.mjs <${Object.keys(handlers).join('|')}>`);
  process.exit(2);
}
await handler();
