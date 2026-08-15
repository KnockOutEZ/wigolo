#!/usr/bin/env node
/**
 * Wall-clock and memory profile of the wigolo MCP server.
 *
 * MEASUREMENT SPIKE — it changes nothing and optimises nothing. It exists so a
 * future performance decision has a number under it.
 *
 * Run (dev host, network required):
 *   RUN_PROFILE=1 PROFILE_SCRATCH=/abs/scratch npx tsx benchmarks/profile/runner.ts
 *
 * Output: benchmarks/profile/output/profile.json  (+ a table on stdout)
 *
 * Method, and why each choice was forced:
 *
 *  - COLD START is measured by spawning the real `dist/index.js mcp` and
 *    timestamping before spawn and on frame arrival. Each cold run gets a FRESH
 *    data dir, so nothing replays a warm path.
 *
 *  - WARM numbers are the Nth call in ONE long-lived process. A cold spawn
 *    over-measures by roughly 2x, so the per-call series is reported in full and
 *    the headline stat is taken from calls >= WARM_SKIP only.
 *
 *  - CACHE is never allowed to decide the answer: every data dir is a throwaway
 *    seeded only with the two model caches (cloned, never the user's ~/.wigolo
 *    database), and every tool call passes force_refresh.
 *
 *  - The THREE-WAY SPLIT is computed by interval UNION, not by summing
 *    durations. Search engines run concurrently, so summed network time exceeds
 *    wall-clock; the union is the part of wall-clock during which the process
 *    was waiting on at least one socket. Whatever is left after subtracting the
 *    union of (network ∪ onnx) is reported as an explicit remainder rather than
 *    folded into "JS".
 */
import { writeFileSync, mkdirSync, rmSync, cpSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  McpChild,
  nowEpochMs,
  unionMs,
  sumMs,
  stats,
  round,
  cpuUsInWindow,
  peakRssInWindow,
  type ProbeInterval,
  type ProbePayload,
} from './mcp-child.js';

if (!process.env.RUN_PROFILE) {
  process.stderr.write('[profile] Skipped. Set RUN_PROFILE=1 to run (needs network).\n');
  process.exit(0);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const DIST = join(ROOT, 'dist', 'index.js');
const HOOK = join(__dirname, 'probe-hook.mjs');
const OUT_DIR = join(__dirname, 'output');

const SCRATCH = process.env.PROFILE_SCRATCH;
if (!SCRATCH) throw new Error('PROFILE_SCRATCH must be an absolute scratch path');
const TEMPLATE = join(SCRATCH, 'wigolo-data-template');
if (!existsSync(join(TEMPLATE, 'fastembed'))) {
  throw new Error(`model-cache template missing at ${TEMPLATE} (see benchmarks/profile/README)`);
}
if (!existsSync(DIST)) throw new Error(`dist/ not built — run npm run build first (${DIST})`);

const COLD_RUNS = Number(process.env.PROFILE_COLD_RUNS ?? 5);
const WARM_CALLS = Number(process.env.PROFILE_WARM_CALLS ?? 8);
/** Calls before this index are warmup and excluded from the headline stat. */
const WARM_SKIP = Number(process.env.PROFILE_WARM_SKIP ?? 3);
/** Quiet period before an "idle" reading is taken. */
const IDLE_SETTLE_MS = Number(process.env.PROFILE_IDLE_SETTLE_MS ?? 4000);
/** Gap between warm calls, to keep trailing background work out of the next window. */
const INTER_CALL_GAP_MS = Number(process.env.PROFILE_GAP_MS ?? 2000);

const SEARCH_QUERIES = [
  'sqlite fts5 bm25 ranking',
  'typescript satisfies operator',
  'http3 quic head of line blocking',
  'onnx runtime quantization int8',
  'postgres logical replication slots',
  'rust async runtime comparison',
  'kubernetes pod disruption budget',
  'webassembly component model',
  'redis cluster resharding',
  'nginx reverse proxy buffering',
  'elasticsearch shard sizing',
  'grpc streaming backpressure',
];

const FETCH_URLS = [
  'https://example.com/',
  'https://www.rfc-editor.org/rfc/rfc7231.html',
  'https://nodejs.org/api/perf_hooks.html',
  'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API',
  'https://sqlite.org/fts5.html',
  'https://www.postgresql.org/docs/current/wal-intro.html',
  'https://nodejs.org/api/worker_threads.html',
  'https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers',
  'https://sqlite.org/wal.html',
  'https://nodejs.org/api/async_hooks.html',
  'https://www.rfc-editor.org/rfc/rfc9110.html',
  'https://developer.mozilla.org/en-US/docs/Web/API/Streams_API',
];

let dirSeq = 0;
function freshDataDir(tag: string): string {
  const dir = join(SCRATCH!, `data-${tag}-${dirSeq++}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  // Clone ONLY the model caches. No cache.db / wigolo.db — a warm database
  // would replay a different path and invalidate every number below.
  cpSync(join(TEMPLATE, 'fastembed'), join(dir, 'fastembed'), { recursive: true });
  cpSync(join(TEMPLATE, 'transformers'), join(dir, 'transformers'), { recursive: true });
  return dir;
}

function childEnv(dataDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    WIGOLO_DATA_DIR: dataDir,
    WIGOLO_LOG_LEVEL: 'error',
    // Keep the measurement on the default backend; the sidecar is opt-in and
    // measuring it would describe a configuration almost nobody runs.
    WIGOLO_SEARCH: 'core',
  };
}

function ofKind(intervals: ProbeInterval[], ...kinds: string[]): ProbeInterval[] {
  return intervals.filter((i) => kinds.includes(i.kind));
}

/**
 * The cross-encoder rerank IS on the response path: search awaits it.
 */
const ONNX_BLOCKING = ['onnx_rerank', 'onnx_rerank_warmup'];
/**
 * Embedding is NOT. `BackgroundIndexQueue` exists precisely so "the worker
 * drains the queue out-of-band so the crawl/search response path returns
 * without paying per-embed cost" (src/embedding/background-queue.ts). It
 * overlaps the call window without blocking it, so counting it as part of the
 * call's wall-clock would be a straightforward over-attribution. It is reported
 * in its own column instead of being folded into the split.
 */
const ONNX_BACKGROUND = ['onnx_embed', 'onnx_embed_warmup'];

interface CallBreakdown {
  n: number;
  label: string;
  wall_ms: number;
  net_union_ms: number;
  /**
   * `net_union_ms - overlap_net_onnx_ms`. THIS is the number reported as the
   * network share, and the asymmetry must be stated: when a socket is
   * outstanding *while* the cross-encoder runs, that overlapping time is
   * credited to RERANK, not to network. The partition is exclusive, but it is
   * not neutral — it biases the network share DOWN and the rerank share UP,
   * which is the same direction as the headline finding. Treat the rerank
   * share as an upper bound.
   */
  net_exclusive_ms: number;
  net_sum_ms: number;
  net_calls: number;
  /** Blocking ONNX only (cross-encoder rerank). */
  onnx_union_ms: number;
  onnx_calls: number;
  /** Concurrent background embedding — overlaps the window, does not block it. */
  bg_embed_union_ms: number;
  bg_embed_calls: number;
  overlap_net_onnx_ms: number;
  attributed_union_ms: number;
  remainder_ms: number;
  /** Summed across ALL threads: the ONNX runtime is a thread pool, so this
   *  routinely exceeds wall-clock. Divided by wall it gives mean parallelism. */
  cpu_ms: number;
  mean_cores: number;
  peak_rss_mb: number;
  window: { from: number; to: number };
}

function breakdown(
  n: number,
  label: string,
  probe: ProbePayload,
  from: number,
  to: number,
): CallBreakdown {
  const net = ofKind(probe.intervals, 'net');
  const onnx = ofKind(probe.intervals, ...ONNX_BLOCKING);
  const bg = ofKind(probe.intervals, ...ONNX_BACKGROUND);
  const netU = unionMs(net, from, to);
  const onnxU = unionMs(onnx, from, to);
  const bothU = unionMs([...net, ...onnx], from, to);
  const overlap = netU + onnxU - bothU;
  const wall = to - from;
  const cpuMs = cpuUsInWindow(probe.samples, from, to) / 1000;
  const inWin = (xs: ProbeInterval[]) => xs.filter((i) => i.t1 > from && i.t0 < to).length;
  return {
    n,
    label,
    wall_ms: round(wall),
    net_union_ms: round(netU),
    net_exclusive_ms: round(netU - overlap),
    net_sum_ms: round(sumMs(net, from, to)),
    net_calls: inWin(net),
    onnx_union_ms: round(onnxU),
    onnx_calls: inWin(onnx),
    bg_embed_union_ms: round(unionMs(bg, from, to)),
    bg_embed_calls: inWin(bg),
    overlap_net_onnx_ms: round(overlap),
    attributed_union_ms: round(bothU),
    remainder_ms: round(wall - bothU),
    cpu_ms: round(cpuMs),
    mean_cores: round(wall > 0 ? cpuMs / wall : 0),
    peak_rss_mb: round(peakRssInWindow(probe.samples, from, to) / 1024 / 1024),
    window: { from, to },
  };
}

// --------------------------------------------------------------------------
// Phase A — cold start
// --------------------------------------------------------------------------
interface ColdRun {
  run: number;
  spawn_to_ready_ms: number;
  spawn_to_first_search_ms: number;
  ready_to_first_search_ms: number;
  boot_net_union_ms: number;
  boot_onnx_union_ms: number;
  first_search: CallBreakdown;
  rss_at_ready_mb: number;
  idle_rss_mb: number;
  idle_ps_rss_mb: number;
  exit_code: number | null;
}

async function coldStart(run: number): Promise<ColdRun> {
  const dataDir = freshDataDir('cold');
  const probeOut = join(SCRATCH!, `probe-cold-${run}.json`);
  rmSync(probeOut, { force: true });

  const child = new McpChild({
    distEntry: DIST,
    env: childEnv(dataDir),
    probeOut,
    hookPath: HOOK,
  });

  const hs = await child.handshake();
  const readyAt = hs.readyAt;

  // Let boot-time background work (engine prewarm) settle, then read idle RSS.
  await sleep(IDLE_SETTLE_MS);
  const idleAt = nowEpochMs();
  const idlePsRssMb = psRssMb(child.proc.pid!);

  const call = await child.callTool('search', {
    query: SEARCH_QUERIES[run % SEARCH_QUERIES.length],
    force_refresh: true,
  });

  const exit = await child.stop();
  const probe = child.readProbe();

  const rssNear = (t: number) => {
    const s = probe.samples.filter((x) => x.t <= t).at(-1);
    return s ? round(s.rss / 1024 / 1024) : 0;
  };

  return {
    run,
    spawn_to_ready_ms: round(readyAt - child.spawnedAt),
    spawn_to_first_search_ms: round(call.doneAt - child.spawnedAt),
    ready_to_first_search_ms: round(call.doneAt - readyAt),
    boot_net_union_ms: round(unionMs(ofKind(probe.intervals, 'net'), child.spawnedAt, readyAt)),
    boot_onnx_union_ms: round(
      unionMs(
        ofKind(probe.intervals, ...ONNX_BLOCKING, ...ONNX_BACKGROUND),
        child.spawnedAt,
        readyAt,
      ),
    ),
    first_search: breakdown(1, 'search(cold)', probe, call.sentAt, call.doneAt),
    rss_at_ready_mb: rssNear(readyAt),
    idle_rss_mb: rssNear(idleAt),
    idle_ps_rss_mb: idlePsRssMb,
    exit_code: exit,
  };
}

// --------------------------------------------------------------------------
// Phase B — warm calls in one long-lived process
// --------------------------------------------------------------------------
interface WarmSession {
  tool: 'search' | 'fetch';
  calls: CallBreakdown[];
  idle_rss_mb: number;
  idle_ps_rss_mb: number;
  peak_rss_mb: number;
  peak_ps_rss_mb: number;
  exit_code: number | null;
}

async function warmSession(tool: 'search' | 'fetch'): Promise<WarmSession> {
  const dataDir = freshDataDir(`warm-${tool}`);
  const probeOut = join(SCRATCH!, `probe-warm-${tool}.json`);
  rmSync(probeOut, { force: true });

  const child = new McpChild({
    distEntry: DIST,
    env: childEnv(dataDir),
    probeOut,
    hookPath: HOOK,
  });
  await child.handshake();
  await sleep(IDLE_SETTLE_MS);
  const idleAt = nowEpochMs();
  const idlePsRssMb = psRssMb(child.proc.pid!);

  let psPeakMb = idlePsRssMb;
  const psTimer = setInterval(() => {
    psPeakMb = Math.max(psPeakMb, psRssMb(child.proc.pid!));
  }, 500);

  const windows: { n: number; from: number; to: number }[] = [];
  for (let n = 1; n <= WARM_CALLS; n++) {
    const args =
      tool === 'search'
        ? { query: SEARCH_QUERIES[(n - 1) % SEARCH_QUERIES.length], force_refresh: true }
        : { url: FETCH_URLS[(n - 1) % FETCH_URLS.length], force_refresh: true };
    const c = await child.callTool(tool, args);
    windows.push({ n, from: c.sentAt, to: c.doneAt });
    // Gap so one call's trailing BACKGROUND work is not credited to the next.
    // The background embed queue can run for seconds after a response returns.
    await sleep(INTER_CALL_GAP_MS);
  }

  clearInterval(psTimer);
  const exit = await child.stop();
  const probe = child.readProbe();

  const idleSample = probe.samples.filter((s) => s.t <= idleAt).at(-1);
  return {
    tool,
    calls: windows.map((w) => breakdown(w.n, tool, probe, w.from, w.to)),
    idle_rss_mb: idleSample ? round(idleSample.rss / 1024 / 1024) : 0,
    idle_ps_rss_mb: idlePsRssMb,
    peak_rss_mb: round(Math.max(...probe.samples.map((s) => s.rss)) / 1024 / 1024),
    peak_ps_rss_mb: round(psPeakMb),
    exit_code: exit,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Outside signal for RSS. `process.memoryUsage.rss()` is the process reporting
 * on itself; a memory claim this large should not rest on a self-report alone,
 * so every idle reading is corroborated by the kernel's own accounting.
 * Returns MB, or 0 if the process is already gone.
 */
function psRssMb(pid: number): number {
  try {
    const out = execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], {
      encoding: 'utf8',
    }).trim();
    return out ? round(Number(out) / 1024) : 0;
  } catch {
    return 0;
  }
}

// --------------------------------------------------------------------------
function pct(part: number, whole: number): string {
  return whole > 0 ? `${((part / whole) * 100).toFixed(0)}%` : '—';
}

function warmTable(s: WarmSession): string {
  const lines: string[] = [];
  lines.push(
    `\n  ${s.tool} — per-call series (calls 1..${WARM_SKIP - 1} are warmup, excluded from the stat)`,
  );
  lines.push(
    `  ${'N'.padStart(3)} ${'wall'.padStart(8)} ${'net∪'.padStart(8)} ${'rerank∪'.padStart(8)} ${'remain'.padStart(8)} ${'cpu'.padStart(8)} ${'cores'.padStart(6)} ${'rss MB'.padStart(7)} ${'[bgEmbed]'.padStart(9)}`,
  );
  for (const c of s.calls) {
    const flag = c.n < WARM_SKIP ? ' (warmup)' : '';
    lines.push(
      `  ${String(c.n).padStart(3)} ${c.wall_ms.toFixed(0).padStart(8)} ${c.net_union_ms.toFixed(0).padStart(8)} ${c.onnx_union_ms.toFixed(0).padStart(8)} ${c.remainder_ms.toFixed(0).padStart(8)} ${c.cpu_ms.toFixed(0).padStart(8)} ${c.mean_cores.toFixed(1).padStart(6)} ${c.peak_rss_mb.toFixed(0).padStart(7)} ${c.bg_embed_union_ms.toFixed(0).padStart(9)}${flag}`,
    );
  }
  const warm = s.calls.filter((c) => c.n >= WARM_SKIP);
  const w = stats(warm.map((c) => c.wall_ms));
  const n = stats(warm.map((c) => c.net_union_ms));
  const o = stats(warm.map((c) => c.onnx_union_ms));
  const r = stats(warm.map((c) => c.remainder_ms));
  const cp = stats(warm.map((c) => c.cpu_ms));
  const bg = stats(warm.map((c) => c.bg_embed_union_ms));
  const co = stats(warm.map((c) => c.mean_cores));
  lines.push(`  warm calls N>=${WARM_SKIP} (n=${w.n})   min / median / max`);
  lines.push(`    wall          ${w.min} / ${w.median} / ${w.max} ms`);
  lines.push(
    `    network∪      ${n.min} / ${n.median} / ${n.max} ms   (${pct(n.median, w.median)} of median wall)`,
  );
  lines.push(
    `    onnx rerank∪  ${o.min} / ${o.median} / ${o.max} ms   (${pct(o.median, w.median)} of median wall)`,
  );
  lines.push(
    `    remainder     ${r.min} / ${r.median} / ${r.max} ms   (${pct(r.median, w.median)} of median wall)`,
  );
  lines.push(`    cpu (all thr) ${cp.min} / ${cp.median} / ${cp.max} ms`);
  lines.push(`    mean cores    ${co.min} / ${co.median} / ${co.max}`);
  lines.push(
    `    [bg embed∪]   ${bg.min} / ${bg.median} / ${bg.max} ms  — CONCURRENT, off the response path; excluded from the split above`,
  );
  const spread = w.max - w.min;
  if (spread > w.median) {
    lines.push(
      `    !! wall spread (${round(spread)} ms) EXCEEDS the median (${w.median} ms) — treat any claimed effect smaller than that as unresolved.`,
    );
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const cold: ColdRun[] = [];
  for (let i = 0; i < COLD_RUNS; i++) {
    process.stderr.write(`[profile] cold run ${i + 1}/${COLD_RUNS}\n`);
    cold.push(await coldStart(i));
  }

  process.stderr.write('[profile] warm search session\n');
  const warmSearch = await warmSession('search');
  process.stderr.write('[profile] warm fetch session\n');
  const warmFetch = await warmSession('fetch');

  const report = {
    generated_at: new Date().toISOString(),
    host: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpus: (await import('node:os')).cpus().length,
    },
    method: {
      cold_runs: COLD_RUNS,
      warm_calls: WARM_CALLS,
      warm_skip: WARM_SKIP,
      data_dir: 'throwaway per run, seeded ONLY with cloned model caches',
      force_refresh: true,
    },
    cold,
    cold_stats: {
      spawn_to_ready_ms: stats(cold.map((c) => c.spawn_to_ready_ms)),
      spawn_to_first_search_ms: stats(cold.map((c) => c.spawn_to_first_search_ms)),
      idle_rss_mb: stats(cold.map((c) => c.idle_rss_mb)),
      rss_at_ready_mb: stats(cold.map((c) => c.rss_at_ready_mb)),
    },
    warm_search: warmSearch,
    warm_fetch: warmFetch,
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'profile.json'), JSON.stringify(report, null, 2));

  const out: string[] = [];
  out.push('\n=== A. COLD START ===');
  out.push(
    `  ${'run'.padStart(4)} ${'spawn→ready'.padStart(12)} ${'spawn→1st search'.padStart(17)} ${'boot net∪'.padStart(10)} ${'rss@ready'.padStart(10)} ${'idle rss'.padStart(9)}`,
  );
  for (const c of cold) {
    out.push(
      `  ${String(c.run + 1).padStart(4)} ${c.spawn_to_ready_ms.toFixed(0).padStart(12)} ${c.spawn_to_first_search_ms.toFixed(0).padStart(17)} ${c.boot_net_union_ms.toFixed(0).padStart(10)} ${c.rss_at_ready_mb.toFixed(0).padStart(10)} ${c.idle_rss_mb.toFixed(0).padStart(9)}`,
    );
  }
  const sr = report.cold_stats.spawn_to_ready_ms;
  const sf = report.cold_stats.spawn_to_first_search_ms;
  const ir = report.cold_stats.idle_rss_mb;
  out.push(`  spawn→ready        min/median/max = ${sr.min} / ${sr.median} / ${sr.max} ms`);
  out.push(`  spawn→first search min/median/max = ${sf.min} / ${sf.median} / ${sf.max} ms`);
  out.push(`  idle RSS           min/median/max = ${ir.min} / ${ir.median} / ${ir.max} MB`);

  out.push('\n=== B. WARM BREAKDOWN ===');
  out.push(warmTable(warmSearch));
  out.push(warmTable(warmFetch));

  const ips = stats(cold.map((c) => c.idle_ps_rss_mb));
  out.push('\n=== C. MEMORY ===');
  out.push(`  idle RSS, in-process (cold sessions): ${ir.min} / ${ir.median} / ${ir.max} MB`);
  out.push(`  idle RSS, ps (outside signal):        ${ips.min} / ${ips.median} / ${ips.max} MB`);
  out.push(
    `  search session: idle ${warmSearch.idle_rss_mb} MB (ps ${warmSearch.idle_ps_rss_mb}) -> peak ${warmSearch.peak_rss_mb} MB (ps ${warmSearch.peak_ps_rss_mb})`,
  );
  out.push(
    `  fetch  session: idle ${warmFetch.idle_rss_mb} MB (ps ${warmFetch.idle_ps_rss_mb}) -> peak ${warmFetch.peak_rss_mb} MB (ps ${warmFetch.peak_ps_rss_mb})`,
  );
  out.push('  NOTE: peak is a session peak and includes the CONCURRENT background embed queue,');
  out.push('        which is not part of any single call\'s response path.');

  process.stdout.write(`${out.join('\n')}\n\n[profile] Wrote ${join(OUT_DIR, 'profile.json')}\n`);
}

main().catch((err) => {
  process.stderr.write(
    `[profile] FAILED: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
