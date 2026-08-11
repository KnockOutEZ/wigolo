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

/** Runs reduced for the idle-RSS gate. */
export const RSS_RUNS = 3;

/**
 * Machine classes. A gate may carry a different limit per class, and the class is ALWAYS
 * printed next to the number.
 *
 * ⚠ This exists because the two classes differ by ~4x on the same statistic, same horizon,
 * same build. A single limit set from a developer Mac reds a clean CI build; a single limit
 * set from a CI runner passes a 100 MiB regression on a laptop. Either way the gate stops
 * measuring what it claims to. The class is passed in EXPLICITLY (`--class`, or
 * `WIGOLO_BUDGET_MACHINE_CLASS`) rather than sniffed from `process.env.CI`, because a gate
 * that guesses which limit applies to it can guess wrong silently — and the guess would be
 * wrong in exactly the direction that hides a regression.
 */
export const MACHINE_CLASSES = ['developer', 'ci-runner'];
export const DEFAULT_MACHINE_CLASS = 'developer';

/** Runs reduced by the median for the cold-start gate. */
export const COLD_START_RUNS = 5;

/**
 * Why the idle-RSS gate reduces ACROSS runs by the minimum, and not by the median.
 *
 * S10-a shipped median-of-3 and recorded that only the median was stable on a CI runner:
 * individual runner floors spanned **162.8-196.3** across six runs (in the 196.3 run the
 * process never decayed at all inside the 45 s horizon), while the medians of the two batches
 * were 163.0 and 166.1. That is true, and it is still not enough to gate on. Working the
 * arithmetic through for a BLOCKING median gate:
 *
 *   - the limit must sit above the worst clean median. One run in six failed to decay, so two
 *     of three doing so is not remote, and that median lands near 196;
 *   - the limit must sit below the lowest clean median plus the 40 MiB leak the probe injects,
 *     i.e. below 163.0 + 40 = 203.
 *
 * That leaves a **6 MiB window** to choose from, against inputs whose own observed spread is
 * 33 MiB. A threshold finer than the resolution of the data behind it is not a threshold, and
 * a blocking gate that reds a clean build teaches people to re-run CI — which destroys the
 * gate more thoroughly than not having one.
 *
 * ⚠ This stopped being a projection while S10-b was still open. Two consecutive commits of the
 * same build — differing only in comments and a test-file path helper — measured medians of
 * **162.8** and **192.3**, the second because two of its three runs failed to decay. The
 * minimum on those same two batches was 162.8 and 163.4. And the estimate the argument above
 * rests on (roughly one non-decay run in six) was itself too generous: over twelve runner runs
 * the rate is **5 in 12**.
 *
 * The minimum removes the problem at its source, and does so on a property this file already
 * states: a floor over a bounded horizon is an UPPER BOUND on the true floor (see
 * RSS_HORIZON_MS). Each run therefore produces an independent upper bound on the SAME
 * quantity, and the tightest of several upper bounds is their minimum. The median of a set of
 * upper bounds estimates nothing in particular; the 196.3 run is not a heavier idle footprint,
 * it is a looser bound, and the minimum discards it for the right reason.
 *
 * ⚠ It does NOT trade away sensitivity, which is the obvious objection. Write each run as
 * `floor_i = true_floor + slack_i` with `slack_i >= 0`. Retained memory raises `true_floor`
 * itself, so a leak of L gives `floor_i >= true_floor + L` for EVERY run, hence
 * `min_i floor_i >= true_floor + L`. The minimum is exactly as sensitive to retained bytes as
 * any single run, and strictly steadier. Measured: min-of-3 returns **162.8** and **163.4** on
 * the two runner batches — a 0.6 MiB spread where the median moved 3.1 — which opens a
 * ~38 MiB window instead of a 6 MiB one.
 *
 * Both statistics are printed on every run. If the minimum ever proves less steady than the
 * median on real runner data, the printed pair is what shows it, and this comment is what has
 * to be argued with.
 */
export const RSS_CROSS_RUN_REDUCER = 'minimum';

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
    statistic: `minimum of ${RSS_HORIZON_MS / RSS_SAMPLE_INTERVAL_MS} samples ${RSS_SAMPLE_INTERVAL_MS}ms apart (the FLOOR, not a plateau), reduced across ${RSS_RUNS} runs by the ${RSS_CROSS_RUN_REDUCER}`,
    horizon: `fixed ${RSS_HORIZON_MS / 1000}s after the initialize response`,
    runs: RSS_RUNS,
    unit: 'MiB',
    comparison: '<=',
    limit: 55,
    limits: {
      developer: 55,
      // Anchored to runner data, per S10-a's closing note. Observed min-of-3 on GitHub
      // macos-latest: 162.8 and 163.4. 185 sits 21.6 above the worst clean observation and
      // 17.8 below where the 40 MiB probe lands (162.8 + 40 = 202.8), so it has real room on
      // both sides — which is precisely what the median statistic could not offer (see
      // RSS_CROSS_RUN_REDUCER). Blocking from S10-b.
      'ci-runner': 185,
    },
    baseline:
      'developer class: floor ranged 17.7-44.2 MiB over 6 runs, measured 2026-08-11 on darwin-arm64 at 7aa08144 (44.2/44.2/44.2 then 17.7/44.2/34.4); 55 sits above the highest observed floor and below the lowest-plus-40, so a clean build passes and a 40 MiB retained allocation reds from anywhere in the range (the spec\'s 130 would have let that leak through). ci-runner class: GitHub macos-latest floors 163.5/163.0/162.8 in one batch and 163.4/196.3/166.1 in a second — ~4x the developer machine on the same statistic and horizon, which is why the two classes carry different limits rather than one loosened number. Individual runner floors span 162.8-196.3 (in the 196.3 run the process never decayed inside the 45s horizon); reduced by the minimum those two batches give 162.8 and 163.4, and 185 is set from that. Two further batches, taken by the blocking gate itself on the S10-b PR: [162.8, 194.8, 162.8] -> min 162.8, then [163.4, 192.3, 192.3] -> min 163.4. ⚠ THE SECOND OF THOSE IS THE CASE THIS GATE WAS DESIGNED AGAINST, OBSERVED LIVE: two of its three runs never decayed inside the horizon, so its MEDIAN was 192.3 where the previous commit\'s was 162.8 — a 29.5 MiB swing between two commits that differ only in comments and a test-file path helper. Across four runner batches the median spans 162.8-192.3 and the minimum spans 162.8-163.4. Non-decay runs are 5 of 12 runner runs, not the 1-in-6 a single batch suggested. 185 is anchored on the minimum and has held on all four. BLOCKING on ci-runner from S10-b.',
  },
  'G-RSS-SUBSTRATE': {
    id: 'G-RSS-SUBSTRATE',
    title: 'idle RSS floor of the MCP server plus the desktop substrate',
    what: 'retained resident memory of `wigolo mcp` and a hidden desktop substrate with one blank tab, whole process tree',
    artifact:
      '`node dist/index.js mcp` plus the built substrate under `electron-vite preview` with WIGOLO_STUDIO_HIDDEN=1, against a fresh empty WIGOLO_DATA_DIR shared by both, sampled via `ps -o rss=` over every process descended from either',
    statistic: `minimum of ${RSS_HORIZON_MS / RSS_SAMPLE_INTERVAL_MS} samples ${RSS_SAMPLE_INTERVAL_MS}ms apart (the FLOOR, not a plateau), summed across the whole process tree, reduced across ${RSS_RUNS} runs by the ${RSS_CROSS_RUN_REDUCER}`,
    horizon: `fixed ${RSS_HORIZON_MS / 1000}s after the substrate publishes a session handle`,
    runs: RSS_RUNS,
    unit: 'MiB',
    comparison: '<=',
    limit: 510,
    limits: {
      developer: 510,
    },
    baseline:
      '⚠ THE SPEC\'S PROVISIONAL 450 REDS AT BASELINE, on the lowest machine class, with no regression present. Spec §4.3 gate 22 states <= 450 MiB and §7.2 records it as "provisional — not yet measured"; it was extrapolated from a "106 MB core" figure that S10-a had already falsified (the core floor is 44.2 developer-class). Measured 2026-08-11 on darwin-arm64 at 96af301a, same statistic and same 45s horizon as G-RSS-IDLE so the two are comparable. THREE batches of three: [493.4, 630.2, 457.5] -> min 457.5, median 493.4; [464.9, 471.3, 473.6] -> min 464.9, median 471.3; [510.9, 509.5, 478.5] -> min 478.5, median 509.5. Every minimum exceeds 450. ⚠ THE THIRD BATCH FALSIFIED WHAT THE FIRST TWO SUPPORTED, and it is recorded rather than dropped: on two batches the minimum spanned 7.4 MiB and a 40 MiB-sensitive blocking gate looked comfortable; on three it spans 21.0 (457.5-478.5), and a 40 MiB gate then needs a limit above 478.5 and below 457.5+40=497.5 — a 19 MiB window against a statistic whose own spread is 21. A threshold finer than the resolution of its data is not a threshold (the same arithmetic that rejected a median reducer for G-RSS-IDLE), so this gate is REPORT-ONLY and states a coarser resolution: 510 detects a retained-memory regression of roughly 53 MiB and up (510 - 457.5) and is blind below that, with 31.5 MiB of headroom over the worst clean observation, about 1.5x the observed spread. Making it blocking needs more batches or a tighter statistic, NOT a narrower number. ⚠ The third batch overlapped ~30s of a vitest run; the contention is recorded because it may have raised that batch, and the observation is kept anyway — discarding an inconvenient measurement is how a gate comes to describe a machine that does not exist, and a higher floor moves the limit in the insensitive direction rather than the falsely-green one. ⚠ CORROBORATION OF THE REDUCER on a workload S10-b never saw: across the three batches the MINIMUM spans 21.0 MiB where the MEDIAN spans 38.2 (471.3-509.5), so the minimum is again the steadier of the two; batch 1 run 2 is another run that never decayed inside the horizon (floor 630.2 against its siblings\' 457-493). Decomposition against G-RSS-IDLE\'s 55: the substrate accounts for roughly 400-455 MiB of the total, so this is overwhelmingly a substrate gate and its resolution is set by the substrate\'s own noise, not the core\'s. ⚠ DEVELOPER CLASS ONLY: G-RSS-IDLE needed a ci-runner limit ~3x its developer one, this gate has no runner observation at all, and the substrate cannot run on `clean-machine-smoke` because that job installs the published package while the only substrate that exists is the apps/studio checkout. S10-d wires it where a substrate is present. ⚠ Every run\'s last sample was still decaying, so as with G-RSS-IDLE the floor is an UPPER BOUND and a longer horizon can only lower it.',
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
      '461 ms median (528/455/456/461/461) measured 2026-08-11 on darwin-arm64 at 7aa08144, and 828 ms then 670 ms median (650/603/731/670/936) on a GitHub macos-latest runner. Median-of-5 rather than a single run: the first spawn on a cold page cache over-measures and is not what a running agent experiences. ONE limit covers both machine classes here, unlike G-RSS-IDLE — the runner is 1.8x slower and still 45% under the bound, so there is no threshold to split. BLOCKING from S10-b: the runner figure is the one that was missing when this shipped report-only, and 828 against 1500 needs no further argument.',
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
    limit: 800,
    baseline:
      "764 MiB measured 2026-08-11 on the GitHub macos-latest runner — browser engine 546, models 218 — for the `warmup --reranker --embeddings` this job runs. ⚠ The S10 spec and brief:180 both price acquisition at ~535 MiB, which is the browser engine ALONE; the 218 MiB of ranking and embedding models is real, is downloaded by the same command, and is quantified here for the first time. Today's cost, not a target: asserted so the tier work is measured against a gate that already existed rather than one written to fit its result. The models were re-measured independently on darwin-arm64 (fastembed 128 + transformers 88 = 216 MiB), so 218 is a property of the download rather than of the runner. ⚠ S10-d's replacement pair CANNOT be stated over this artifact — see SUBSTRATE_ONLY_ACQUISITION. ⚠ KEPT UNCHANGED BY S10-d, deliberately: it is the gate that prices the tier-INDEPENDENT models, and it is what catches amended-D1's doubling regression — a run that acquires the desktop component AND the browser engine lands at 300 + 546 + 218 = 1064 against this 800.",
  },
  'G-ACQUIRE-SUBSTRATE-DESKTOP': {
    id: 'G-ACQUIRE-SUBSTRATE-DESKTOP',
    title: 'desktop-component bytes acquired on the desktop tier',
    what: 'growth of the desktop-component directory across a `wigolo warmup` that resolved to the desktop tier',
    artifact:
      'a `du -sm` snapshot of <WIGOLO_DATA_DIR>/substrate taken before warmup and differenced after it; a directory absent at snapshot time counts as 0. SCOPED TO THE COMPONENT DIRECTORY ALONE — never the full acquisition set',
    statistic: 'single directory delta, negative clamped to 0',
    horizon: 'n/a — warmup exiting is the terminating condition',
    runs: 1,
    unit: 'MiB',
    comparison: '<=',
    limit: 320,
    baseline:
      'the component measures 300 MiB (Electron 43.0.0 runtime, real install.js, darwin-arm64 at 96af301a), and 320 keeps the spec\'s ~6.7% headroom over it. ⚠ THE ARTIFACT IS THE CORRECTION, NOT THE NUMBER: the spec states this gate over the FULL acquisition set, where 320 is unreachable because 218 MiB of that set is ranking and embedding models and those are TIER-INDEPENDENT — no browser rung stops warmup downloading a reranker, so a clean desktop run totals 300 + 218 = 518 and reds a <=320 stated over the total. Scoped to the component directory the same 320 is both reachable and meaningful. ⚠ This gate is only as strong as its PAIR: read alone it passes trivially on a host that acquired nothing at all. It is the DIFFERENTIAL against G-ACQUIRE-SUBSTRATE-HEADLESS — same command, same artifact, same job, opposite tier — that carries the claim, which is why CI runs both arms and why neither is wired without the other.',
  },
  'G-ACQUIRE-SUBSTRATE-HEADLESS': {
    id: 'G-ACQUIRE-SUBSTRATE-HEADLESS',
    title: 'desktop-component bytes acquired on the no-display tier',
    what: 'growth of the desktop-component directory across a `wigolo warmup` that resolved to the no-display tier',
    artifact:
      'identical to G-ACQUIRE-SUBSTRATE-DESKTOP — the same directory, the same du, the same warmup command; only the resolved tier differs',
    statistic: 'single directory delta, negative clamped to 0',
    horizon: 'n/a — warmup exiting is the terminating condition',
    runs: 1,
    unit: 'MiB',
    comparison: '==',
    limit: 0,
    baseline:
      'EXACT, and exact is the point. D-S10-5 claims a host with no display server acquires ZERO bytes of desktop component — not "few", not "less" — because a machine that cannot map a window cannot run the component at all, so any byte spent on it is pure waste on precisely the CI/server/container class the brief names as a standing complaint. ⚠ THE SPEC STATES THIS `== 0` OVER THE FULL ACQUISITION SET, WHERE IT IS UNREACHABLE: a no-display host still downloads the 218 MiB of tier-independent models, so `== 0` over the total reds for a host that behaved perfectly. "Zero" is only expressible over a component-scoped artifact, and loosening it to a small `<=` instead would have destroyed the only thing `==` is for. Baseline 0 MiB, and it stays 0 for as long as the no-display branch is correct.',
  },
};

/**
 * ⚠ G-TOTAL-DESKTOP (spec §4.3 gate 20, §6) — DROPPED, and deliberately NOT replaced with a
 * number. It was never shipped, so this is a decision recorded rather than a threshold edited.
 *
 * The spec states `node_modules + acquired, desktop <= 1000 MiB` against "today's 780 + 535 =
 * 1315". Both inputs have since been measured and both were wrong: prod `node_modules` is 700
 * (post-C1) and acquisition is 764, so today's total is **1464**, and a clean desktop run after
 * this slice's flip is **700 + 518 = 1218**. 1000 is unreachable in either world.
 *
 * The reason it is not simply re-derived upward is arithmetic, not taste. Two gates already
 * block on this job — G-DIET at <= 720 and G-ACQUIRE at <= 800 — and they jointly bound the
 * composed total at **1520** whether or not anything asserts it. The lowest value this
 * composition can currently take is 1464. So the entire window in which a composed gate could
 * fail while both of its components pass is **1464-1520, i.e. 56 MiB**, against a sum of two
 * measurements that each carry tens of MiB of legitimate transitive churn. A threshold finer
 * than the resolution of the data behind it is not a threshold — the same arithmetic that
 * rejected a median reducer for G-RSS-IDLE and that keeps G-RSS-SUBSTRATE report-only. Shipping
 * one anyway would add a gate that cannot fail without one of the other two failing first, and
 * that reds a clean build when they do.
 *
 * ⚠ WHAT WOULD MAKE IT DERIVABLE, so this is a deferral and not a deletion: the window opens
 * the moment the desktop arm acquires a real component instead of degrading. Then the clean
 * desktop total is ~1218 and a limit near **1280** sits ~5% above it, far below today's 1464,
 * and would red on a return to acquiring both rungs (700 + 1064 = 1764). Re-derive it there,
 * against a measurement, not against this note.
 */
export const G_TOTAL_DESKTOP_DROPPED = {
  specLimitMiB: 1000,
  measuredTodayMiB: 1464,
  measuredPostFlipMiB: 1218,
  jointBoundOfShippedGatesMiB: 1520,
  reDeriveAtMiB: 1280,
};

/**
 * ⚠ Why S10-d's replacement pair cannot be stated over G-ACQUIRE's artifact, and what to
 * measure instead.
 *
 * Spec §4.3 replaces G-ACQUIRE with two tier-conditional gates: G-ACQUIRE-DESKTOP <= 320 MiB
 * ("296 substrate + headroom; today 535") and G-ACQUIRE-HEADLESS == 0 MiB. Both were derived
 * while acquisition was believed to be the browser engine alone. It is not: S10-a measured
 * 764 MiB, of which **218 MiB is ranking and embedding models**, and those models are
 * TIER-INDEPENDENT. No browser rung makes `warmup` stop downloading a reranker.
 *
 * Worked against G-ACQUIRE's own artifact (growth of `ms-playwright` + the data dir):
 *
 *   desktop, post-S10-d   = substrate 300 + models 218 + browser engine 0 = ~518 MiB
 *   no-display, post-S10-d = substrate   0 + models 218 + browser engine 0 = ~218 MiB
 *
 * So `<= 320` reds at baseline with no regression present, and `== 0` reds at baseline for a
 * host that correctly downloaded nothing at all of the substrate. That is the same error class
 * as the spec's G-DIET 670 (§ G-DIET baseline): a threshold derived from one line item and then
 * asserted over a total.
 *
 * The fix is not a bigger number, because a bigger number would destroy what `==` is for.
 * D-S10-5's claim is that a no-display host acquires ZERO SUBSTRATE BYTES — exact, and true —
 * and "zero substrate" is only expressible over a substrate-scoped artifact. So S10-d should:
 *
 *   1. scope the tier-conditional pair to the SUBSTRATE directory alone, where 320 keeps its
 *      ~6.7% headroom over a measured 300 and `== 0` becomes both exact and achievable; and
 *   2. keep THIS gate, over the full artifact, unchanged. It is what still prices the models,
 *      and it is what catches the doubling regression D1 fears: acquiring the substrate AND the
 *      browser engine lands at 300 + 546 + 218 = 1064, well over the 800 limit.
 *
 * Substrate baseline for (1): **300 MiB**, `du -sm node_modules/electron` after a real
 * `node node_modules/electron/install.js` on darwin-arm64 at 96af301a — Electron 43.0.0, the
 * version `apps/studio` pins. This corroborates the spec's 296 on a second machine.
 * ⚠ Platform-scoped like every other baseline here: the linux and win32 substrate downloads
 * have NOT been measured, and the packaged S16-alpha app is a different artifact again.
 *
 * ✅ S10-d DID BOTH. (1) is G-ACQUIRE-SUBSTRATE-DESKTOP / -HEADLESS above, scoped to the
 * component directory; (2) is G-ACQUIRE, left at 800 over the full artifact. The spec's third
 * replacement, G-TOTAL-DESKTOP, was dropped rather than re-derived — see G_TOTAL_DESKTOP_DROPPED.
 */
export const SUBSTRATE_ONLY_ACQUISITION = {
  substrateMiB: 300,
  modelsMiB: 218,
  browserEngineMiB: 546,
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

/**
 * Minimum of a numeric series — the cross-run reducer for the idle-RSS gate.
 *
 * Distinct from {@link floorMiB}, which reduces SAMPLES within one run. This reduces the
 * per-run floors across runs, and the reason it is the minimum rather than the median is
 * derived in RSS_CROSS_RUN_REDUCER: each run's floor is an upper bound on the same quantity,
 * so the tightest available estimate is the smallest of them.
 */
export function minimum(values) {
  if (!values.length) throw new Error('minimum of an empty series');
  return Math.min(...values);
}

/** Median of a numeric series. Even-length series average the two middle values. */
export function median(values) {
  if (!values.length) throw new Error('median of an empty series');
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * The limit that applies to a machine class.
 *
 * An unknown class is an ERROR rather than a silent fall-back to the default. A typo in a CI
 * argument would otherwise apply a developer-machine limit to a runner, red a clean build, and
 * present as a regression — the failure mode is a wasted afternoon, and it is free to prevent.
 */
export function limitFor(gate, machineClass = DEFAULT_MACHINE_CLASS) {
  if (!MACHINE_CLASSES.includes(machineClass)) {
    throw new Error(`unknown machine class ${JSON.stringify(machineClass)} (expected one of ${MACHINE_CLASSES.join(', ')})`);
  }
  return gate.limits?.[machineClass] ?? gate.limit;
}

/**
 * Apply a gate's assertion to a measurement.
 *
 * `==` is exact on purpose. G-ACQUIRE's no-display arm (S10-d) asserts zero substrate bytes,
 * and "zero" expressed as "<= some small number" is a different, weaker claim.
 */
export function evaluate(gate, measured, machineClass = DEFAULT_MACHINE_CLASS) {
  const limit = limitFor(gate, machineClass);
  const pass = gate.comparison === '==' ? measured === limit : measured <= limit;
  return { pass, gate, measured, limit, machineClass };
}

/**
 * The report a gate prints.
 *
 * The protocol is part of the OUTPUT, not a comment in a file nobody opens when the gate
 * reds. Someone reading a red in a CI log needs to know what was measured and over what
 * horizon before they can tell a regression from a re-measurement.
 */
export function renderReport(gate, measured, { pass, detail = '', machineClass = DEFAULT_MACHINE_CLASS } = {}) {
  const lines = [
    `${pass ? 'PASS' : 'FAIL'} ${gate.id} — ${gate.title}`,
    `  measured:  ${measured} ${gate.unit}`,
    `  limit:     ${gate.comparison} ${limitFor(gate, machineClass)} ${gate.unit}`,
    `  class:     ${machineClass}${gate.limits ? ' (this gate carries a limit per machine class)' : ''}`,
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
