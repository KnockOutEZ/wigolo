/*
 * Budget gates: the protocol, the reducers, and the thresholds — the parts with no I/O.
 *
 * WHY a protocol object exists at all. A budget number without a measurement protocol is a
 * flake generator, not a gate. This program has the receipts: the same MCP build has been
 * reported as idling at 47 MB, at 106 MB, and at 291 / 284 / 196 / 205 MB, and every one of
 * those numbers was honestly measured. They disagree because they are DIFFERENT STATISTICS
 * OVER DIFFERENT HORIZONS, not because the build changed. See RSS_HORIZON_MS.
 *
 * So every gate here carries `what` / `artifact` / `statistic` / `horizon` / `runs`, the
 * runner prints them next to the number, and the unit tests assert the printed report
 * actually contains them. The protocol travels with the measurement or the measurement means
 * nothing.
 *
 * Thresholds are anchored to an observation, and each records that observation. A threshold
 * with no recorded baseline is indistinguishable from a guess, and this file exists because
 * guesses have already cost this program time.
 */

/** Gap between RSS samples. */
export const RSS_SAMPLE_INTERVAL_MS = 3000;

/**
 * Fixed observation horizon for the idle-RSS gate, and the reason the gate is stated as a
 * FLOOR over a horizon rather than as a "settled" value.
 *
 * ⚠ There is no moment at which this process "has settled". Measured on this build, three
 * runs, `ps -o rss=` every 3 s after the `initialize` response (MiB):
 *
 *   run 1  225.9 226.0 196.5 196.4 196.4 127.0 123.7 123.7 123.7 123.6 123.6 123.6 123.6 123.6 44.2 44.2 44.2 44.2 44.2 44.7
 *   run 2  219.7 219.9 133.7 133.7 133.5 125.4 125.4 125.2  72.8  70.3  45.0  45.0  44.8  44.2 44.2 44.2 44.2 44.2 44.2 44.6
 *   run 3  169.7 169.4 149.1 149.1 149.1 147.6 143.3 143.3 143.3 143.3 143.3 143.3  45.4  44.5 44.2 44.2 44.2 44.2 29.5 30.2
 *
 * The decay is a STAIRCASE with long treads: it holds flat for four or five samples, drops,
 * holds flat again, drops. Every "wait until it stops moving" rule therefore stops on a tread
 * and reports whichever tread that run happened to be sitting on. Applying a first-plateau
 * rule (three consecutive samples within 5%) to the three series above returns
 * **196.4 / 141.6 / 143.3** — a 39% spread on one unchanged build. That is the same failure
 * mode as the fixed-6-second window that returned 291 / 284 / 196 / 205: both sample a
 * transient and call it a resting state.
 *
 * The FLOOR is steadier. Taking the minimum over a fixed 45 s horizon returned
 * **44.2 / 44.2 / 44.2** on those three runs — exact agreement — and **17.7 / 44.2 / 34.4** on
 * a second batch of three. So the honest statement is a RANGE, not a point: six observed runs
 * put the floor between **17.7 and 44.2 MiB**, against a plateau statistic that ranged over
 * 141.6-196.4 on the same build. The floor is the better statistic and it is still noisy.
 *
 * ⚠ That noise sets what this gate can see. A gate cannot detect a change smaller than the
 * spread of its own statistic, so this one detects retained-memory regressions of roughly
 * 40 MiB and up, and is blind below that. Saying so is not a caveat to be smoothed away — a
 * gate whose resolution is unstated invites someone to read a 10 MiB "improvement" out of it.
 * The threshold is chosen against the range: above the highest observed floor (44.2) so a
 * clean build passes, and below the lowest observed floor plus a 40 MiB leak (17.7 + 40 =
 * 57.7) so the probe reds from anywhere in the range.
 *
 * Two properties make the floor the right statistic for THIS gate rather than merely the
 * steadier one:
 *
 *  1. The gate's question is "did this change cost idle memory", and what a change costs is
 *     RETAINED memory. Retained bytes cannot be collected, so they raise the floor and stay
 *     there; transient peaks are the garbage collector's schedule, not the diff's cost.
 *  2. A floor measured over a bounded horizon is an UPPER BOUND on the true floor — a longer
 *     observation can only find a lower value, never a higher one. For a `<=` assertion that
 *     error runs in the safe direction: it can produce a false red, never a false green.
 *
 * Why 45 s and not 60 s: extending the first batch to 60 s dropped run 3 again, to 29.5. That
 * is the upper-bound property working as described, and it is also why the horizon is pinned
 * rather than left to "however long the runner felt like". A gate whose horizon drifts is a
 * gate whose number drifts.
 *
 * ⚠ What this does NOT claim: that 44.2 is "the" idle footprint on every machine or every
 * base. It is what this statistic returns, on darwin-arm64, at 7aa08144. The point of pinning
 * the statistic and the horizon is that the next person measures the same thing.
 */
export const RSS_HORIZON_MS = 45000;

/** Runs reduced by the median for the idle-RSS gate. */
export const RSS_RUNS = 3;

/** Runs reduced by the median for the cold-start gate. */
export const COLD_START_RUNS = 5;

/**
 * The gates.
 *
 * `limit` + `comparison` are the assertion. `baseline` records the observation the limit came
 * from, so a future reader can tell a measured threshold from an invented one.
 *
 * ⚠ Platform scope: every baseline below was measured on darwin-arm64. Install size is NOT
 * platform-invariant — `@img/*`, `@napi-rs/*` and `wreq-js` all resolve to platform-specific
 * packages — so these gates are wired on macOS only until someone measures the others.
 * Gating linux and win32 against a darwin number would be gating against a guess, which is
 * the exact failure this file exists to prevent.
 */
export const GATES = {
  'G-DIET': {
    id: 'G-DIET',
    title: 'production node_modules on disk',
    what: 'total bytes of the dependency tree a `npm i -g wigolo` user installs',
    artifact:
      'a fresh `npm install --omit=dev --ignore-scripts --no-workspaces` into an empty directory holding only package.json + package-lock.json, with PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 and ELECTRON_SKIP_BINARY_DOWNLOAD=1',
    statistic: 'single `du -sm node_modules` total',
    horizon: 'n/a — a completed install is at rest',
    runs: 1,
    unit: 'MiB',
    comparison: '<=',
    limit: 720,
    baseline:
      '700 MiB measured 2026-08-11 on darwin-arm64 at 7aa08144 (post-C1). Headroom ~3%: tight enough that re-adding any package C1 removed reds it, wide enough to absorb transitive churn.',
    // The S10 spec's gate 17 states 670 MiB, derived as "780 measured minus a 111 MiB Tier-A
    // diet". C1's install-side removal actually measured 66.4 MiB — the 111/106 figure added
    // startup bytes to install bytes — so 670 was never reachable, and asserting it here would
    // red at baseline with no regression present. S10-e tightens this once the browser deps
    // leave the core default path. Until then the gate guards the floor that exists rather
    // than one that does not.
  },
  'G-TARBALL': {
    id: 'G-TARBALL',
    title: 'published tarball, unpacked',
    what: 'unpacked size of the artifact `npm publish` would upload',
    artifact: '`npm pack --dry-run --json` in the repo root, `unpackedSize` field',
    statistic: 'single value',
    horizon: 'n/a',
    runs: 1,
    unit: 'MiB',
    comparison: '<=',
    limit: 15,
    baseline:
      '8.4 MiB / 1998 files measured 2026-08-11 at 7aa08144. A regression guard, not a lever: the install-weight problem is node_modules, and a gate on the tarball measures almost none of it.',
  },
  'G-RSS-IDLE': {
    id: 'G-RSS-IDLE',
    title: 'idle RSS floor of the MCP server',
    what: 'retained resident memory of `wigolo mcp` at rest, with no substrate running',
    artifact: '`node dist/index.js mcp` against a fresh empty WIGOLO_DATA_DIR, sampled via `ps -o rss=`',
    statistic: `minimum of ${RSS_HORIZON_MS / RSS_SAMPLE_INTERVAL_MS} samples ${RSS_SAMPLE_INTERVAL_MS}ms apart (the FLOOR, not a plateau), median of ${RSS_RUNS} runs`,
    horizon: `fixed ${RSS_HORIZON_MS / 1000}s after the initialize response`,
    runs: RSS_RUNS,
    unit: 'MiB',
    comparison: '<=',
    limit: 55,
    baseline:
      'floor ranged 17.7-44.2 MiB over 6 runs, measured 2026-08-11 on darwin-arm64 at 7aa08144 (44.2/44.2/44.2 then 17.7/44.2/34.4). The limit sits above the highest observed floor and below the lowest-plus-40, so a clean build passes and a 40 MiB retained allocation reds from anywhere in the range. The spec\'s 130 would have let that leak through.',
  },
  'G-COLD-START': {
    id: 'G-COLD-START',
    title: 'cold start to `initialize`',
    what: 'wall time from process spawn to the MCP `initialize` response arriving on stdout',
    artifact: '`node dist/index.js mcp` against a fresh empty WIGOLO_DATA_DIR per run',
    statistic: `median of ${COLD_START_RUNS} runs, on a warm process tree`,
    horizon: 'n/a — the response IS the terminating condition',
    runs: COLD_START_RUNS,
    unit: 'ms',
    comparison: '<=',
    limit: 1500,
    baseline:
      '461 ms median (528/455/456/461/461) measured 2026-08-11 on darwin-arm64 at 7aa08144. Median-of-5 rather than a single run: the first spawn on a cold page cache over-measures and is not what a running agent experiences. The limit stays at the spec\'s 1500 because CI runners are materially slower than this machine.',
  },
  'G-ACQUIRE': {
    id: 'G-ACQUIRE',
    title: 'bytes `warmup` downloads',
    what: 'growth of the acquisition directories across a `wigolo warmup` run',
    artifact:
      'a `du -sm` snapshot of each acquisition directory taken before warmup and differenced after it; a directory absent at snapshot time counts as 0',
    statistic: 'sum of per-directory deltas, negative deltas clamped to 0',
    horizon: 'n/a — warmup exiting is the terminating condition',
    runs: 1,
    unit: 'MiB',
    comparison: '<=',
    limit: 700,
    baseline:
      "today's cost, not a target: chromium 341 + chromium-headless-shell 191 + ffmpeg 3 (~535 MiB of browser engine) plus the ranking and embedding models. Asserted now so the tier work is measured against a gate that already existed rather than one written to fit its result. S10-d replaces this with the amended-D1 pair (desktop <= 320, no-display == 0).",
  },
};

/**
 * The floor of a sample series: the smallest value observed.
 *
 * Deliberately trivial. The judgement is in the horizon and in choosing the floor over a
 * plateau (see RSS_HORIZON_MS); it is not in the reducer, and a clever reducer here would be
 * re-introducing exactly the discretion that produced 196.4 / 141.6 / 143.3.
 *
 * @param {Array<{ tMs: number, valueMB: number }>} samples
 * @returns {number}
 */
export function floorMiB(samples) {
  if (!samples.length) throw new Error('floor of an empty series');
  return Math.min(...samples.map((s) => s.valueMB));
}

/** Median of a numeric series. Even-length series average the two middle values. */
export function median(values) {
  if (!values.length) throw new Error('median of an empty series');
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Apply a gate's assertion to a measurement.
 *
 * `==` is exact on purpose. G-ACQUIRE's no-display arm (S10-d) asserts zero substrate bytes,
 * and "zero" expressed as "<= some small number" is a different, weaker claim.
 */
export function evaluate(gate, measured) {
  const pass = gate.comparison === '==' ? measured === gate.limit : measured <= gate.limit;
  return { pass, gate, measured };
}

/**
 * The report a gate prints.
 *
 * The protocol is part of the OUTPUT, not a comment in a file nobody opens when the gate
 * reds. Someone reading a red in a CI log needs to know what was measured and over what
 * horizon before they can tell a regression from a re-measurement.
 */
export function renderReport(gate, measured, { pass, detail = '' } = {}) {
  const lines = [
    `${pass ? 'PASS' : 'FAIL'} ${gate.id} — ${gate.title}`,
    `  measured:  ${measured} ${gate.unit}`,
    `  limit:     ${gate.comparison} ${gate.limit} ${gate.unit}`,
    `  what:      ${gate.what}`,
    `  artifact:  ${gate.artifact}`,
    `  statistic: ${gate.statistic}`,
    `  horizon:   ${gate.horizon}`,
    `  runs:      ${gate.runs}`,
    `  baseline:  ${gate.baseline}`,
  ];
  if (detail) lines.push(`  detail:    ${detail}`);
  return lines.join('\n');
}
