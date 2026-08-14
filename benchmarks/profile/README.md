# benchmarks/profile — wall-clock and memory profile

A measurement harness, not an optimiser. It answers three questions and nothing
else:

- **A.** Where does MCP cold start go — process start to ready, and to first result?
- **B.** For a warm `search` and a warm `fetch`, how does wall-clock split across
  network round-trips, native ONNX inference, and JS?
- **C.** What is idle and peak RSS?

Nothing in `src/` is modified. All instrumentation lives here and is applied to
the built `dist/` at load time via a `--import` preload, so the measured process
is the real one.

## Prerequisites

`dist/` must be built. Profiling an unbuilt tree measures the wrong thing:

```bash
npm run build
```

A scratch directory holding a **model-cache template**. Every run gets a
throwaway `WIGOLO_DATA_DIR` seeded from this template, so no measurement ever
touches `~/.wigolo` — a warm cache database replays a different code path and
silently invalidates the numbers.

```bash
export PROFILE_SCRATCH=/tmp/wigolo-profile
mkdir -p "$PROFILE_SCRATCH/wigolo-data-template"
cp -Rc ~/.wigolo/fastembed     "$PROFILE_SCRATCH/wigolo-data-template/fastembed"
cp -Rc ~/.wigolo/transformers  "$PROFILE_SCRATCH/wigolo-data-template/transformers"
```

Only the two model caches are cloned — never `wigolo.db` or `cache.db`. Cloning
the models rather than re-downloading them keeps the measurement about wigolo
rather than about Hugging Face's CDN.

## Running

All three are network-dependent and gated behind `RUN_PROFILE=1`.
**Run them sequentially** — concurrent suites destroy timing measurements.

```bash
# Cold-start attribution: runtime boot / module graph / subsystem init.
RUN_PROFILE=1 npx tsx benchmarks/profile/boot-breakdown.ts

# Which dependency owns the module-graph cost.
RUN_PROFILE=1 npx tsx benchmarks/profile/import-bisect.ts

# Cold start, warm per-call breakdown, and RSS, over the real stdio MCP server.
RUN_PROFILE=1 npx tsx benchmarks/profile/runner.ts
```

Knobs: `PROFILE_COLD_RUNS` (5), `PROFILE_WARM_CALLS` (8), `PROFILE_WARM_SKIP`
(3), `PROFILE_BOOT_RUNS` (7), `PROFILE_IMPORT_RUNS` (7).

JSON lands in `benchmarks/profile/output/`.

## Method, and why each choice was forced

**Warm, not cold.** A cold spawn over-measures per-call latency by roughly 2x.
Warm figures are the Nth call in one long-lived process; the full per-call
series is printed so warmup is visible rather than averaged away, and the
headline statistic excludes calls below `PROFILE_WARM_SKIP`.

**Distributions, not readings.** Every figure is min / median / max over the run
count. A single reading here moves by tens of milliseconds between runs.

**Union, not sum.** Search engines are queried concurrently, so summing `fetch`
durations exceeds wall-clock and would make the network look like more than 100%
of it. The harness records each call as an interval and computes the **union**
— the part of wall-clock during which at least one socket was outstanding. The
sum is reported alongside it as "total network work", clearly distinguished.

**An explicit remainder.** `wall − union(network ∪ onnx)` is reported as its own
column. It is never folded into "JS", because part of it is event-loop idle
rather than compute. CPU time is reported next to it so the two can be told
apart: a remainder with near-zero CPU is waiting, not work.

**Cross-process clock.** The in-child probe and the parent both timestamp with
`performance.timeOrigin + performance.now()`, a high-resolution epoch clock
backed by the same system clock, which is what makes intersecting the child's
intervals with the parent's request windows valid.

**Partial logs are rejected.** A truncated probe log reads exactly like a
finished one. `exit_t` is written only in the exit handler, and the reader
throws if it is absent rather than reporting an under-count.

## Files

| File | Role |
|---|---|
| `probe-hook.mjs` | `--import` preload: wraps `globalThis.fetch`, samples RSS/CPU, flushes JSON on exit |
| `probe-loader.mjs` | module-load hook; appends probe registration to the two ONNX provider modules so the runtime still loads lazily |
| `mcp-child.ts` | minimal stdio MCP client + interval-union / percentile maths |
| `runner.ts` | phases A, B, C against the real server |
| `boot-breakdown.ts` + `boot-probe.mjs` | cold start split into runtime boot / module graph / per-subsystem init |
| `import-bisect.ts` | isolated per-dependency import cost |

`import-bisect` rows are **isolated** imports that share sub-graphs, so they do
not sum to the whole-graph row. That is a property of the measurement, not an
error in it.
