#!/usr/bin/env node
/*
 * Budget gate runner. One subcommand per gate; exits non-zero when a gate fails.
 *
 *   node scripts/budget/measure.mjs install-size
 *   node scripts/budget/measure.mjs tarball
 *   node scripts/budget/measure.mjs idle-rss
 *   node scripts/budget/measure.mjs substrate-rss    # needs the apps/studio checkout, built
 *   node scripts/budget/measure.mjs cold-start
 *   node scripts/budget/measure.mjs acquire-snapshot <file>            # before `wigolo warmup`
 *   node scripts/budget/measure.mjs acquire-snapshot <after-file>      # the instant it exits
 *   node scripts/budget/measure.mjs acquire-diff <file> [after-file]   # assert, whenever
 *   node scripts/budget/measure.mjs substrate-snapshot <file>          # before a tiered warmup
 *   node scripts/budget/measure.mjs substrate-diff <file> <gate-id>    # after it
 *
 * These do not belong in vitest. A unit test cannot perform an install, cannot spawn a real
 * server and watch it settle, and cannot observe what `warmup` downloads — it can only assert
 * over a fixture, and a fixture of an install size is a number someone typed. The reducers
 * (plateau detection, median, the assertion itself) ARE unit-tested; they live in
 * protocol.mjs precisely so they can be.
 *
 * `acquire-*` is split into separate invocations because the thing being measured is the delta
 * across a step this script does not own: CI already runs `wigolo warmup` with a specific set
 * of flags, and re-running it here would both double the download and measure a warm cache.
 *
 * ⚠ THREE invocations, not two, and the third is the correction. `acquire-diff` used to `du`
 * the directories LIVE at assertion time, which made the measured window "everything between
 * the snapshot and whenever the gate happens to be evaluated" rather than "the warmup run".
 * In CI those are not the same window: the assertion sits three steps and ~3 minutes after
 * warmup exits, and in between the job fetches a live page and runs a live search against the
 * DEFAULT data directory — so every byte of cached web content those wrote was charged to a
 * gate whose title is "bytes `warmup` downloads". Measured over 10 runs of the current tree
 * that contamination was 1-13 MiB of pure run-to-run noise on a gate with 7 MiB of headroom.
 * Taking a SECOND snapshot the instant warmup exits closes the window where it belongs and
 * leaves the assertion where it was, so an acquisition red still cannot hide the tool-call
 * step's result.
 */
import { execFileSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, copyFileSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
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

/**
 * Run npm, synchronously, and hand back whatever the caller's `stdio` asked for.
 *
 * WHY IT IS A HELPER AND NOT TWO INLINE TERNARIES: `shell` is not optional on win32. Node's
 * CVE-2024-27980 hardening refuses to `spawnSync` a `.cmd` or `.bat` at all — `npm.cmd` comes
 * back `EINVAL`, as "never ran" rather than as a failed npm — so every npm call in this file
 * needs the same flag, and the two that existed both lacked it. That went unnoticed because the
 * budget gates are wired on the macOS runner only; it surfaced the moment a test started running
 * one of them cross-OS. One spawn seam, so a third call site cannot reintroduce it.
 */
function npmRun(args, options) {
  const win = process.platform === 'win32';
  return execFileSync(win ? 'npm.cmd' : 'npm', args, { ...options, shell: win });
}

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
    npmRun(
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

/**
 * npm's `--json` payload, dug out of a stdout that is not only JSON.
 *
 * `npm pack` runs the `prepare` lifecycle hook — even under `--dry-run`, and even under
 * `--ignore-scripts` (verified on npm 10.9.2: the flag does not suppress the packed project's
 * own prepare). Since `prepare` builds (it has to; a pinned git-dependency install has no other
 * hook — see scripts/prepare-build.mjs), the builder's progress lands on the same stream ahead
 * of the JSON and a bare `JSON.parse(out)` dies on it.
 *
 * npm writes its payload LAST, so the parse walks candidate `[` line-starts from the end and
 * takes the first that parses to completion. Anchoring on the end rather than the first `[`
 * matters: build output is full of bracketed prefixes, and the first one that happens to parse
 * would be a wrong answer rather than an error.
 */
function parseTrailingJsonArray(out) {
  const lines = out.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith('[')) continue;
    try {
      const parsed = JSON.parse(lines.slice(i).join('\n'));
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* not the payload — keep walking back */
    }
  }
  throw new Error(`npm pack --json produced no parsable JSON array (${out.length} bytes of stdout)`);
}

function measureTarball() {
  const out = npmRun(['pack', '--dry-run', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const meta = parseTrailingJsonArray(out)[0];
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

/**
 * Per-child sizes of an acquisition directory, so a reading can be attributed rather than
 * merely disputed.
 *
 * ⚠ THE REASON THIS EXISTS. Both components of this gate have been observed drifting on the
 * runner with no code change behind it, and the only evidence a run left was one number per
 * directory — which is enough to see that something moved and never enough to say what. A
 * per-child breakdown makes the NEXT red self-explaining: the pinned browser download is
 * chromium + chromium-headless-shell + ffmpeg and measures 534 MiB reproducibly off-runner, so
 * a run reporting 554 either names the child that grew or proves no child did.
 */
function childrenMiB(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const name of readdirSync(path).sort()) out[name] = duMiB(join(path, name));
  return out;
}

/** `name +delta` for every child whose size moved, largest first. Empty string when none did. */
function childDeltas(before = {}, after = {}) {
  const moved = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .map((name) => ({ name, delta: (after[name] ?? 0) - (before[name] ?? 0) }))
    .filter((c) => c.delta !== 0)
    .sort((a, b) => b.delta - a.delta);
  return moved.map((c) => `${c.name} ${c.delta > 0 ? '+' : ''}${c.delta}`).join(' ');
}

function acquireSnapshot(file) {
  const dirs = acquisitionDirs();
  const snap = Object.fromEntries(
    Object.entries(dirs).map(([k, p]) => [k, { path: p, mib: duMiB(p), children: childrenMiB(p) }]),
  );
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify(snap, null, 2));
  console.log(`snapshot: ${Object.entries(snap).map(([k, v]) => `${k}=${v.mib}MiB`).join(' ')}`);
}

/**
 * Difference two acquisition snapshots.
 *
 * `afterFile` is what closes the measurement window at the end of the step being measured
 * rather than at the moment the gate runs. It is optional so a developer can still run
 * snapshot/warmup/diff by hand, but CI passes it — see the header note: without it this gate
 * charges whatever the rest of the job wrote into the data directory to `warmup`.
 */
function acquireDiff(file, afterFile) {
  const before = JSON.parse(readFileSync(file, 'utf8'));
  const after = afterFile ? JSON.parse(readFileSync(afterFile, 'utf8')) : null;
  const parts = [];
  let total = 0;
  for (const [key, { path, mib, children }] of Object.entries(before)) {
    const now = after ? (after[key]?.mib ?? 0) : duMiB(path);
    const nowChildren = after ? (after[key]?.children ?? {}) : childrenMiB(path);
    const delta = Math.max(0, now - mib);
    total += delta;
    const attribution = childDeltas(children, nowChildren);
    parts.push(`${key} ${mib}->${now} (+${delta})${attribution ? ` [${attribution}]` : ''}`);
  }
  const window = after ? 'window closed at the end of the measured step' : 'window closed live at assertion time';
  return report('G-ACQUIRE', total, `${parts.join(', ')}; ${window}`);
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
  'acquire-diff': () => acquireDiff(arg ?? join(ROOT, 'budget-acquire.json'), arg2),
};

const handler = handlers[subcommand];
if (!handler) {
  console.error(`usage: measure.mjs <${Object.keys(handlers).join('|')}>`);
  process.exit(2);
}
await handler();
