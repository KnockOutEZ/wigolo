#!/usr/bin/env node
/*
 * Budget gate runner. One subcommand per gate; exits non-zero when a gate fails.
 *
 *   node scripts/budget/measure.mjs install-size
 *   node scripts/budget/measure.mjs tarball
 *   node scripts/budget/measure.mjs idle-rss
 *   node scripts/budget/measure.mjs substrate-rss    # needs the apps/studio checkout, built
 *   node scripts/budget/measure.mjs cold-start
 *   node scripts/budget/measure.mjs acquire-snapshot <file>   # before `wigolo warmup`
 *   node scripts/budget/measure.mjs acquire-diff <file>       # after it
 *   node scripts/budget/measure.mjs substrate-snapshot <file>          # before a tiered warmup
 *   node scripts/budget/measure.mjs substrate-diff <file> <gate-id>    # after it
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
  DEFAULT_MACHINE_CLASS,
  floorMiB,
  median,
  minimum,
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

/**
 * Which machine class this run's limits come from. Explicit, never sniffed — a gate that
 * guesses its own limit can guess wrong in the direction that hides a regression.
 */
const MACHINE_CLASS = process.env.WIGOLO_BUDGET_MACHINE_CLASS || DEFAULT_MACHINE_CLASS;

function report(gateId, measured, detail) {
  const gate = GATES[gateId];
  const { pass } = evaluate(gate, measured, MACHINE_CLASS);
  console.log(renderReport(gate, measured, { pass, detail, machineClass: MACHINE_CLASS }));
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
    // `--ignore-scripts` above suppresses OUR postinstall along with everyone else's, so run it
    // here. Without this the gate measures a tree no user ever has and, worse, cannot see the
    // prune being removed — see G-DIET's note on why the artifact runs a script.
    const before = duMiB(join(dir, 'node_modules'));
    // `dir` is passed explicitly: run.mjs resolves onnxruntime-node from it, NOT from this
    // checkout, or the gate would prune the developer's own node_modules instead of the tree
    // it is measuring.
    execFileSync(process.execPath, [join(ROOT, 'scripts', 'prune', 'run.mjs'), dir], {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    const total = duMiB(join(dir, 'node_modules'));
    return report(
      'G-DIET',
      total,
      `pre-prune ${before} MiB, post-prune ${total} MiB | largest: ${largestPackages(join(dir, 'node_modules'), dir)}`,
    );
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
  // Both cross-run statistics are printed, always. The gate asserts on the minimum (see
  // RSS_CROSS_RUN_REDUCER); the median rides along so that if the minimum ever proves the less
  // steady of the two on real runner data, the evidence is already in the log rather than
  // needing a re-run to discover.
  const detail = `${traces.join('; ')} | floors=[${floors.join(' ')}] min=${minimum(floors)} median=${median(floors)}`;
  return report('G-RSS-IDLE', minimum(floors), detail);
}

// ------------------------------------------------------- idle RSS + substrate

/**
 * Every process in a tree, by walking `ps -eo pid=,ppid=`.
 *
 * `pgrep -P` is one level and an Electron tree is three (launcher -> main -> renderer / GPU /
 * network / utility helpers). Charging only the process we spawned would understate the
 * substrate by most of its cost, which is the entire quantity this gate exists to bound.
 */
function descendantPids(rootPid) {
  const children = new Map();
  for (const line of execFileSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8' }).trim().split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const seen = [];
  const stack = [rootPid];
  while (stack.length) {
    const p = stack.pop();
    seen.push(p);
    for (const c of children.get(p) ?? []) stack.push(c);
  }
  return seen;
}

function treeRssMiB(pids) {
  let total = 0;
  for (const pid of pids) {
    try {
      const out = execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim();
      if (out) total += Number.parseInt(out, 10) / 1024;
    } catch {
      // The process exited between enumeration and sampling. Skipping it understates by that
      // process, which runs in the safe direction for a `<=` assertion.
    }
  }
  return Math.round(total * 10) / 10;
}

/**
 * Start the desktop substrate, hidden, and resolve once it has published a session handle.
 *
 * ⚠ This drives the DEV CHECKOUT, because that is the only substrate that exists:
 * `installedSubstrateExists()` returns false until S16-alpha ships a distributable app. It runs
 * the BUILT bundles under `preview` rather than `dev`, so a vite dev server and its HMR
 * machinery are not charged to the substrate's idle footprint — `dev` would measure the
 * toolchain as much as the product. When S16-alpha lands, this is the function that points at
 * the installed app instead, and the number should be re-taken rather than assumed to carry.
 */
async function spawnSubstrateHidden(dataDir) {
  const studio = spawn('npx', ['electron-vite', 'preview'], {
    cwd: join(ROOT, 'apps', 'studio'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, WIGOLO_DATA_DIR: dataDir, WIGOLO_STUDIO_HIDDEN: '1' },
  });
  studio.stdout.resume();
  studio.stderr.resume();
  const handlePath = join(dataDir, 'studio', 'current.json');
  const start = Date.now();
  while (Date.now() - start < 90000) {
    if (existsSync(handlePath)) {
      // The host opens its own blank tab on start. Let the renderer exist before the horizon
      // begins, or the first samples measure a half-started tree rather than an idle one.
      await sleep(3000);
      return studio;
    }
    await sleep(500);
  }
  throw new Error('substrate never published a session handle within 90s');
}

function killTree(child) {
  for (const pid of descendantPids(child.pid)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}

/** One run of the core + substrate footprint. Same statistic and horizon as G-RSS-IDLE. */
async function substrateRssFloorOnce() {
  const dataDir = freshDataDir();
  const { child: mcp, ready } = spawnMcpAndInit(dataDir);
  let studio = null;
  try {
    await ready;
    studio = await spawnSubstrateHidden(dataDir);
    const samples = [];
    const start = Date.now();
    while (Date.now() - start < RSS_HORIZON_MS) {
      await sleep(RSS_SAMPLE_INTERVAL_MS);
      // Re-enumerated every sample: Electron spawns helpers lazily, and a tree fixed at t=0
      // would silently stop counting whatever appeared at t=6s.
      const live = [...descendantPids(mcp.pid), ...descendantPids(studio.pid)];
      samples.push({ tMs: Date.now() - start, valueMB: treeRssMiB(live) });
    }
    return { floor: floorMiB(samples), samples };
  } finally {
    if (studio) killTree(studio);
    mcp.kill('SIGKILL');
    rmSync(dataDir, { recursive: true, force: true });
  }
}

async function measureSubstrateRss() {
  if (process.platform === 'win32') throw new Error('RSS sampling uses `ps`; wire a win32 sampler before gating there');
  const floors = [];
  const traces = [];
  for (let i = 0; i < RSS_RUNS; i++) {
    const { floor, samples } = await substrateRssFloorOnce();
    floors.push(floor);
    traces.push(`run${i + 1} floor=${floor} [${samples.map((s) => s.valueMB).join(' ')}]`);
  }
  const detail = `${traces.join('; ')} | floors=[${floors.join(' ')}] min=${minimum(floors)} median=${median(floors)}`;
  return report('G-RSS-SUBSTRATE', minimum(floors), detail);
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

/**
 * The desktop-component directory alone — the narrower artifact S10-d's tier-conditional pair is
 * stated over. Separate from {@link acquisitionDirs} on purpose: the whole correction is that a
 * threshold derived from one line item cannot be asserted over a total, and the way to keep that
 * honest is for the two artifacts to be two functions.
 */
function substrateDir() {
  return join(process.env.WIGOLO_DATA_DIR || join(homedir(), '.wigolo'), 'substrate');
}

function substrateSnapshot(file) {
  const path = substrateDir();
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify({ path, mib: duMiB(path) }, null, 2));
  console.log(`substrate snapshot: ${path} = ${duMiB(path)}MiB`);
}

/**
 * Difference the component directory and report it against ONE of the tier-conditional gates.
 *
 * The gate id is passed in rather than sniffed from the environment, for the same reason the
 * machine class is: this measurement is identical in both arms and only the EXPECTATION differs,
 * so a runner that guessed which arm it was in could report a headless run against the desktop
 * gate and pass while acquiring bytes it should not have.
 */
function substrateDiff(file, gateId) {
  if (!GATES[gateId]) {
    console.error(`unknown gate ${JSON.stringify(gateId)} (expected one of ${Object.keys(GATES).join(', ')})`);
    process.exit(2);
  }
  const before = JSON.parse(readFileSync(file, 'utf8'));
  const now = duMiB(before.path);
  const delta = Math.max(0, now - before.mib);
  return report(gateId, delta, `${before.path} ${before.mib}->${now} (+${delta})`);
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

const [subcommand, arg, arg2] = process.argv.slice(2);
const handlers = {
  'substrate-snapshot': () => substrateSnapshot(arg ?? join(ROOT, 'budget-substrate.json')),
  'substrate-diff': () => substrateDiff(arg ?? join(ROOT, 'budget-substrate.json'), arg2 ?? 'G-ACQUIRE-SUBSTRATE-DESKTOP'),
  'install-size': measureInstallSize,
  tarball: measureTarball,
  'idle-rss': measureIdleRss,
  'substrate-rss': measureSubstrateRss,
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
