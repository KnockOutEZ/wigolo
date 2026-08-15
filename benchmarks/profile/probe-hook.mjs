/**
 * In-child instrumentation preload for the profiling spike.
 *
 * Loaded with `node --import ./benchmarks/profile/probe-hook.mjs dist/index.js mcp`.
 * It never ships in `src/` and changes no product behaviour: it only wraps
 * existing call boundaries to record when they were busy.
 *
 * What it records, all as epoch-millisecond floats so the PARENT process can
 * intersect them with its own request/response timestamps:
 *
 *   net          — every `globalThis.fetch` call (search engines + page fetch
 *                  both go through the global; verified by grep over src/).
 *   onnx_embed   — FastembedEmbedProvider.prototype.embed
 *   onnx_rerank  — TransformersRerankProvider.prototype.rerank
 *   onnx_warmup  — first-call model load for either provider
 *   marks        — module-graph / subsystem milestones during boot
 *   samples      — periodic { t, rss, cpu_user_us, cpu_system_us }
 *
 * Attribution is done by INTERVAL UNION in the parent, not by summing
 * durations: engine calls run concurrently, so a naive sum of `net` durations
 * exceeds wall-clock and would make the network look like more than 100%.
 *
 * `performance.timeOrigin + performance.now()` gives a high-resolution epoch
 * clock that both processes share (same system clock), which is what makes the
 * cross-process intersection valid.
 */
import { register } from 'node:module';
import { writeFileSync } from 'node:fs';

const OUT = process.env.WIGOLO_PROFILE_OUT;

function nowEpochMs() {
  return performance.timeOrigin + performance.now();
}

const intervals = [];
const marks = [];
const samples = [];

const probe = {
  begin(kind, meta) {
    const t0 = nowEpochMs();
    return (extra) => {
      intervals.push({ kind, t0, t1: nowEpochMs(), ...(meta ? { meta } : {}), ...(extra ?? {}) });
    };
  },
  mark(name) {
    marks.push({ name, t: nowEpochMs() });
  },
  /** Wrap an async prototype method so each invocation records an interval. */
  wrapProto(proto, method, kind) {
    if (!proto || typeof proto[method] !== 'function' || proto[method].__wgWrapped) return;
    const orig = proto[method];
    const wrapped = async function (...args) {
      const end = probe.begin(kind);
      try {
        return await orig.apply(this, args);
      } finally {
        end();
      }
    };
    wrapped.__wgWrapped = true;
    proto[method] = wrapped;
  },
};
globalThis.__wgProbe = probe;

probe.mark('preload_start');

// --- network boundary -------------------------------------------------------
const realFetch = globalThis.fetch;
globalThis.fetch = async function (input, init) {
  const url = typeof input === 'string' ? input : (input?.url ?? String(input));
  const end = probe.begin('net');
  let res;
  try {
    res = await realFetch.call(this, input, init);
  } catch (err) {
    end({ host: safeHost(url), failed: true });
    throw err;
  }
  // A Response resolves as soon as headers land; the body is still on the wire.
  // Wrap the body-draining methods so the interval covers the real transfer.
  const closeOnBody = () => end({ host: safeHost(url), status: res.status });
  let settled = false;
  for (const m of ['text', 'json', 'arrayBuffer', 'blob', 'bytes']) {
    if (typeof res[m] !== 'function') continue;
    const origM = res[m].bind(res);
    res[m] = async (...a) => {
      try {
        return await origM(...a);
      } finally {
        if (!settled) {
          settled = true;
          closeOnBody();
        }
      }
    };
  }
  // If nothing ever drains the body, close the interval on the next tick so a
  // discarded response cannot leave an interval open to the end of the process.
  queueMicrotask(() => {
    setTimeout(() => {
      if (!settled) {
        settled = true;
        closeOnBody();
      }
    }, 0).unref?.();
  });
  return res;
};

function safeHost(u) {
  try {
    return new URL(u).host;
  } catch {
    return 'unknown';
  }
}

// --- ONNX boundaries, patched by appending to the module source -------------
// Patching at load time (rather than eagerly importing these modules here)
// keeps the preload from dragging the ONNX runtime into the cold-start path
// and distorting the very number we are trying to measure.
register(new URL('./probe-loader.mjs', import.meta.url).href, import.meta.url);

// --- periodic RSS / CPU sampling -------------------------------------------
const SAMPLE_MS = Number(process.env.WIGOLO_PROFILE_SAMPLE_MS ?? 20);
function sample() {
  const cpu = process.cpuUsage();
  samples.push({
    t: nowEpochMs(),
    rss: process.memoryUsage.rss(),
    cpu_user_us: cpu.user,
    cpu_system_us: cpu.system,
  });
}
sample();
const timer = setInterval(sample, SAMPLE_MS);
timer.unref?.();

// --- flush ------------------------------------------------------------------
let flushed = false;
function flush() {
  if (!OUT) return;
  sample();
  const payload = {
    pid: process.pid,
    node: process.version,
    time_origin: performance.timeOrigin,
    exit_t: nowEpochMs(),
    // Raw getrusage value. Units differ per platform, so the parent reports the
    // SAMPLED peak as primary and only cross-checks against this.
    max_rss_raw: process.resourceUsage().maxRSS,
    intervals,
    marks,
    samples,
  };
  try {
    writeFileSync(OUT, JSON.stringify(payload));
  } catch {
    /* best effort — a failed flush must not change the measured process */
  }
}
// A partial log reads exactly like a finished one, so `exit_t` is written only
// here and the parent refuses to trust a file that lacks it.
process.on('exit', () => {
  if (!flushed) {
    flushed = true;
    flush();
  }
});
// Parent-requested flush for runs it wants to read before teardown.
process.on('SIGUSR2', () => flush());

probe.mark('preload_end');
