import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain-JS build tooling, deliberately not part of the typed src/ graph.
import { GATES, RSS_HORIZON_MS, RSS_SAMPLE_INTERVAL_MS, MACHINE_CLASSES, SUBSTRATE_ONLY_ACQUISITION, G_TOTAL_DESKTOP_DROPPED, floorMiB, median, minimum, limitFor, evaluate, renderReport } from '../../scripts/budget/protocol.mjs';

/*
 * WHY these tests exist.
 *
 * The budget gates themselves cannot run here — a unit test cannot perform an npm install,
 * spawn a server and watch it for 45 seconds, or observe what `warmup` downloads. What CAN
 * be tested, and what has actually gone wrong in this program, is the REDUCTION: which
 * statistic is taken over which horizon, and whether the number that comes out is stable.
 *
 * Three numbers have been recorded for the idle footprint of the same MCP server — 47 MB,
 * 106 MB, and 291/284/196/205 MB — and all three were honestly measured. The tests below pin
 * the explanation: they are different statistics over different horizons, and the unstable
 * one is the plateau. The naive rule is reimplemented here as a CONTROL rather than shipped
 * in protocol.mjs, because a rule kept only to be contrasted against belongs in the test that
 * contrasts it, not in the runner.
 */

/** Real `ps -o rss=` traces, 3 s apart, taken after the initialize response on darwin-arm64 @ 7aa08144. */
const TRACES: Record<string, number[]> = {
  run1: [225.9, 226.0, 196.5, 196.4, 196.4, 127.0, 123.7, 123.7, 123.7, 123.6, 123.6, 123.6, 123.6, 123.6, 44.2, 44.2, 44.2, 44.2, 44.2, 44.7],
  run2: [219.7, 219.9, 133.7, 133.7, 133.5, 125.4, 125.4, 125.2, 72.8, 70.3, 45.0, 45.0, 44.8, 44.2, 44.2, 44.2, 44.2, 44.2, 44.2, 44.6],
  run3: [169.7, 169.4, 149.1, 149.1, 149.1, 147.6, 143.3, 143.3, 143.3, 143.3, 143.3, 143.3, 45.4, 44.5, 44.2, 44.2, 44.2, 44.2, 29.5, 30.2],
};

const asSamples = (values: number[]) => values.map((valueMB, i) => ({ tMs: (i + 1) * RSS_SAMPLE_INTERVAL_MS, valueMB }));

/** Samples falling inside the gate's fixed horizon. */
const withinHorizon = (values: number[]) => asSamples(values).filter((s) => s.tMs <= RSS_HORIZON_MS);

/**
 * The CONTROL: "the first sample within `tolerance` of the previous", generalised to a window
 * of `window` consecutive samples. This is the rule the S10 spec prescribes. It is here to be
 * shown unstable, not to be used.
 */
function firstPlateau(samples: Array<{ tMs: number; valueMB: number }>, window = 3, tolerance = 0.05) {
  for (let i = 0; i + window <= samples.length; i++) {
    const slice = samples.slice(i, i + window).map((s) => s.valueMB);
    const min = Math.min(...slice);
    const max = Math.max(...slice);
    if (min > 0 && (max - min) / min <= tolerance) return samples[i + window - 1].valueMB;
  }
  return null;
}

describe('idle-RSS statistic: floor over a fixed horizon, not a plateau', () => {
  it('the floor agrees across runs where the plateau rule does not', () => {
    // This is the whole argument for the statistic, stated as one comparison. If a future
    // change makes the plateau rule agree too, this test stops justifying the choice and
    // should be revisited rather than deleted.
    const floors = Object.values(TRACES).map((t) => floorMiB(withinHorizon(t)));
    const plateaus = Object.values(TRACES).map((t) => firstPlateau(withinHorizon(t)));

    expect(floors).toEqual([44.2, 44.2, 44.2]);
    expect(new Set(plateaus).size).toBeGreaterThan(1);
    expect(Math.max(...(plateaus as number[])) - Math.min(...(plateaus as number[]))).toBeGreaterThan(40);
  });

  it('the plateau rule stops on a tread of the staircase, 3x above the floor', () => {
    // Concretely: run1 holds flat at 196.4 for three samples long before it has finished
    // decaying. Any "wait until it stops moving" rule reports that as the resting state.
    expect(firstPlateau(withinHorizon(TRACES.run1))).toBe(196.4);
    expect(floorMiB(withinHorizon(TRACES.run1))).toBe(44.2);
  });

  it('a two-sample plateau rule is worse still — it fires on the very first tread', () => {
    // 225.9 -> 226.0 is 0.04% apart at t=3s and t=6s, so the "first sample within 5% of the
    // previous" wording taken literally reports the transient at its peak.
    expect(firstPlateau(withinHorizon(TRACES.run1), 2)).toBe(226.0);
  });

  it('the horizon is part of the statistic: extending it can only lower the floor', () => {
    // run3 drops again at t=57s. A floor measured over a bounded horizon is an UPPER BOUND on
    // the true floor, so the error runs toward a false red and never toward a false green.
    // This is why the horizon is pinned rather than left to whatever the runner had time for.
    const bounded = floorMiB(withinHorizon(TRACES.run3));
    const extended = floorMiB(asSamples(TRACES.run3));
    expect(extended).toBeLessThan(bounded);
    expect(bounded).toBe(44.2);
    expect(extended).toBe(29.5);
  });

  it('the floor is the minimum, not whatever the last sample happened to be', () => {
    // Added because a probe caught this suite failing to discriminate: replacing the floor
    // with "the last sample in the horizon" left 22 of 23 tests green, since in all three
    // 45 s traces the final sample IS the minimum. RSS ticks back up at the end of every one
    // of these runs (44.2 -> 44.7, 44.2 -> 44.6, 29.5 -> 30.2), so the full series does
    // distinguish the two rules — and now something asserts on it.
    for (const trace of Object.values(TRACES)) {
      const samples = asSamples(trace);
      expect(floorMiB(samples)).toBeLessThan(samples[samples.length - 1].valueMB);
    }
  });

  it('rejects an empty series instead of inventing a floor', () => {
    expect(() => floorMiB([])).toThrow(/empty/);
  });
});

describe('median', () => {
  it('reduces odd-length runs to the middle value regardless of order', () => {
    expect(median([528, 455, 456, 461, 461])).toBe(461);
    expect(median([461, 461, 456, 455, 528])).toBe(461);
  });

  it('averages the two middle values on an even-length series', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it('resists the outlier a single run would have reported', () => {
    // The point of median-of-N for cold start: the first spawn on a cold page cache is the
    // one that over-measures, and a single-run gate would be gated on exactly that sample.
    expect(median([1400, 455, 456])).toBe(456);
  });

  it('rejects an empty series', () => {
    expect(() => median([])).toThrow(/empty/);
  });
});

describe('evaluate', () => {
  it('passes a measurement at the limit and fails one above it', () => {
    const gate = GATES['G-DIET'];
    expect(evaluate(gate, gate.limit).pass).toBe(true);
    expect(evaluate(gate, gate.limit + 1).pass).toBe(false);
  });

  it('treats `==` as exact, so "zero" cannot be satisfied by "nearly zero"', () => {
    // S10-d's no-display arm asserts the substrate downloads ZERO bytes. Expressed as a
    // `<=` that claim silently weakens into "not very many bytes", which is a different
    // promise to a user on a headless host.
    const exact = { ...GATES['G-ACQUIRE'], comparison: '==', limit: 0 };
    expect(evaluate(exact, 0).pass).toBe(true);
    expect(evaluate(exact, 1).pass).toBe(false);
  });
});

describe("G-DIET's threshold is set by the regression it has to catch", () => {
  /*
   * Measured on the protocol the gate itself runs — `npm install --omit=dev --ignore-scripts
   * --no-workspaces` into an empty directory holding only package.json + package-lock.json.
   *
   * Locally on darwin-arm64, minutes apart:
   *   bc0ccf4b            698 MiB / 388 packages   (driver on the default install path)
   *   bc0ccf4b + S10-e    681 MiB / 386 packages   (driver an optional peer)
   *
   * The per-package diff between those two trees is exactly `playwright` and `playwright-core`
   * removed, nothing added — so the regression is observed, not modelled, and the 17 MiB delta
   * is platform-stable because both packages are pure JS.
   *
   * ⚠ THE THRESHOLD IS ANCHORED TO THE RUNNER, NOT THE LAPTOP. This gate runs on exactly one
   * machine class (clean-machine-smoke, macos-latest, node 22), and that machine measured 685
   * then 683 across two runs of this branch — up to 4 MiB above local, with ~2 MiB of variance
   * of its own. Shipping the laptop-derived 690 would have left a clean build 5 MiB of room on
   * the only machine that runs the gate. The anchor is the WORSE runner reading, not the better.
   */
  /*
   * ⚠ RE-DERIVED for the onnxruntime-node platform prune. Measured on this laptop, on the
   * protocol the gate runs (`--ignore-scripts` install, then `scripts/prune/run.mjs`):
   *
   *   pre-prune    681 MiB   — reproduces S10-e's recorded local reading to the MiB
   *   post-prune   503 MiB   — per-package diff is ONE line, onnxruntime-node 216536 -> 35064 KiB
   *
   * The runner read 685 for the tree that measures 681 here, so the clean runner prediction is
   * 685 - 178 = 507. That is a PREDICTION and the anchor moves to the runner's own number the
   * moment CI produces one; what makes it a usable one is that the offset is being applied to a
   * pre-prune figure that reproduces exactly.
   */
  const CLEAN_BUILD_MIB = 507;
  const DRIVER_BACK_ON_DEFAULT_PATH_MIB = 507 + 17;
  const PRUNE_REVERTED_MIB = 507 + 178;

  it('passes the measured clean build', () => {
    expect(evaluate(GATES['G-DIET'], CLEAN_BUILD_MIB).pass).toBe(true);
  });

  it('reds when the browser driver returns to the default install path', () => {
    // The thing most likely to be undone by accident: a later change moves `playwright` back
    // into `dependencies`. If this gate cannot see that, it is guarding nothing that S10-e did.
    expect(evaluate(GATES['G-DIET'], DRIVER_BACK_ON_DEFAULT_PATH_MIB).pass).toBe(false);
  });

  it('reds when the platform prune stops happening', () => {
    // The regression this slice adds: the postinstall is dropped, or a refactor makes it
    // silently no-op, and 178 MiB of other platforms' binaries come back. Easy to catch — which
    // is exactly why it must not be the regression the threshold is sized against.
    expect(evaluate(GATES['G-DIET'], PRUNE_REVERTED_MIB).pass).toBe(false);
  });

  it('would NOT catch the 17 MiB one if sized against the 178 MiB one', () => {
    // ⚠ THE TRAP THIS ASSERTION EXISTS TO PIN, in its new form. The old trap was a habitual 3%;
    // at these numbers 3% happens to be safe (507 * 1.03 = 522 < 524), so keeping that assertion
    // would be keeping a claim that is no longer true. The live trap is the opposite one: the
    // total just fell 178 MiB, and sizing the new headroom as a share of THAT is the natural
    // move. A tenth of the saving gives 507 + 17.8 = 525, which sits ABOVE the 524 that the
    // driver regression lands on — so the gate would sail past the very thing it was guarding
    // before this slice, and the 178 MiB win would have cost the 17 MiB one.
    const sizedAgainstTheWin = Math.round(CLEAN_BUILD_MIB + 178 * 0.1);
    expect(sizedAgainstTheWin).toBeGreaterThan(DRIVER_BACK_ON_DEFAULT_PATH_MIB);
    expect(limitFor(GATES['G-DIET'])).toBeLessThan(sizedAgainstTheWin);
    expect(limitFor(GATES['G-DIET'])).toBeLessThan(DRIVER_BACK_ON_DEFAULT_PATH_MIB);
  });

  it('still leaves a clean build room to grow', () => {
    // The other half of the constraint: a gate a clean build cannot pass is worse than no gate.
    // 515 - 507 = 8 MiB on the machine that runs it, against the 4 MiB laptop-to-runner spread
    // and ~2 MiB of commit-to-commit drift on this artifact — the same 8 the previous threshold
    // carried, which is what the 17 MiB window leaves room for once the 9 MiB margin is kept.
    expect(limitFor(GATES['G-DIET'])).toBeGreaterThan(CLEAN_BUILD_MIB);
    expect(limitFor(GATES['G-DIET']) - CLEAN_BUILD_MIB).toBeGreaterThanOrEqual(8);
  });
});

describe('gate definitions', () => {
  const ids = Object.keys(GATES);

  it.each(ids)('%s states its full measurement protocol', (id) => {
    // D-S10-6: a budget assertion without a protocol is a flake generator. This is the test
    // that makes that requirement enforceable rather than aspirational — a gate added later
    // with a bare number fails here.
    const gate = GATES[id];
    for (const field of ['what', 'artifact', 'statistic', 'horizon', 'runs', 'unit', 'comparison', 'limit', 'baseline'] as const) {
      expect(gate[field], `${id} is missing \`${field}\``).toBeDefined();
    }
    expect(String(gate.what).length).toBeGreaterThan(20);
    expect(String(gate.baseline).length).toBeGreaterThan(20);
  });

  it.each(ids)('%s renders its protocol into the report a red would print', (id) => {
    // The protocol has to reach the CI log. Someone reading a failure needs to know what was
    // measured and over what horizon before they can tell a regression from a re-measurement,
    // and they will not go and read this file to find out.
    const gate = GATES[id];
    const out = renderReport(gate, gate.limit, { pass: true });
    expect(out).toContain(gate.what);
    expect(out).toContain(gate.artifact);
    expect(out).toContain(gate.statistic);
    expect(out).toContain(gate.horizon);
    expect(out).toContain(gate.baseline);
    expect(out).toContain(`${gate.comparison} ${gate.limit} ${gate.unit}`);
  });

  it('every threshold is reachable from its own recorded baseline', () => {
    // A limit is only meaningful next to the observation it came from. This catches the
    // failure where a threshold is edited to make a red go away and the baseline text is
    // left describing the old number.
    for (const id of ids) expect(GATES[id].baseline, `${id}`).toMatch(/\d/);
  });

  it('the idle-RSS limit can actually catch the leak its probe injects', () => {
    // The arithmetic that chose 55 rather than the spec's 130, pinned so a later widening has
    // to argue with it: from the LOWEST observed floor (17.7) a 40 MiB retained allocation
    // must still red, and from the HIGHEST (44.2) a clean build must still pass.
    const gate = GATES['G-RSS-IDLE'];
    expect(evaluate(gate, 44.2).pass).toBe(true);
    expect(evaluate(gate, 17.7 + 40).pass).toBe(false);
  });
});

/**
 * Real core+substrate floors, two batches of three, darwin-arm64 at 96af301a. Same statistic
 * and same 45 s horizon as G-RSS-IDLE, so the two gates' numbers are comparable and the
 * difference between them is attributable to the substrate rather than to the statistic.
 */
const SUBSTRATE_FLOOR_BATCHES = [
  [493.4, 630.2, 457.5],
  [464.9, 471.3, 473.6],
  // Taken by the shipped runner itself. ⚠ This batch falsified what the first two supported —
  // see 'the third batch is why this gate is report-only'.
  [510.9, 509.5, 478.5],
];

/** The leak size a probe would inject, matching G-RSS-IDLE's. */
const PROBE_LEAK_MIB = 40;

/**
 * `protocol.mjs` is plain JS outside the typed graph, so its reducers arrive returning
 * `unknown`. Narrowing them once here keeps the arithmetic below readable AND keeps this file
 * off the type-check debt ratchet — an `unknown[]` inference in a test reaches CI as debt, and
 * the ratchet is the only cover core test files have.
 */
const minOf = (values: number[]): number => Number(minimum(values));
const medianOf = (values: number[]): number => Number(median(values));

describe('G-RSS-SUBSTRATE — the spec’s provisional 450 had no basis, and does not survive one', () => {
  const gate = GATES['G-RSS-SUBSTRATE'];

  it('would have reddened a clean build on the lowest machine class', () => {
    // WHY this is pinned rather than just corrected: 450 was extrapolated from a "106 MB core"
    // figure S10-a had already falsified, and the same extrapolation habit produced G-DIET's
    // unreachable 670. Both measured minimums exceed it, on the class that measures LOWEST.
    for (const batch of SUBSTRATE_FLOOR_BATCHES) expect(minimum(batch)).toBeGreaterThan(450);
  });

  it('passes every clean observation, so it cannot teach anyone to re-run CI', () => {
    // A blocking-shaped gate that reds a clean build destroys itself faster than not existing.
    // Asserted over all three batches, including the highest.
    for (const batch of SUBSTRATE_FLOOR_BATCHES) expect(evaluate(gate, minimum(batch)).pass).toBe(true);
  });

  it('catches a regression at the resolution it claims, and not a finer one', () => {
    // 510 - 457.5 = 52.5, so the honest claim is "roughly 53 MiB and up". Both halves are
    // asserted: a 53 MiB regression from the lowest clean floor must red, and the gate must NOT
    // be credited with catching the 40 MiB one G-RSS-IDLE catches.
    const lowest = Math.min(...SUBSTRATE_FLOOR_BATCHES.map(minOf));
    expect(evaluate(gate, lowest + 53).pass).toBe(false);
    expect(evaluate(gate, lowest + PROBE_LEAK_MIB).pass).toBe(true);
  });

  it('the third batch is why this gate is report-only, not a narrower number', () => {
    // WHY THIS TEST EXISTS: on the first two batches the minimum spanned 7.4 MiB and a
    // 40 MiB-sensitive BLOCKING gate looked comfortable. The third batch moved the spread to
    // 21.0, and the window a 40 MiB gate would have to fit in — above the worst clean minimum,
    // below the lowest plus the leak — is then NARROWER than the spread of the statistic
    // itself. That is the same arithmetic that rejected a median reducer for G-RSS-IDLE, and
    // the conclusion is the same: not a finer threshold, a coarser claim.
    const mins = SUBSTRATE_FLOOR_BATCHES.map(minOf);
    const spread = Math.max(...mins) - Math.min(...mins);
    const windowAt40 = Math.min(...mins) + PROBE_LEAK_MIB - Math.max(...mins);
    expect(windowAt40).toBeLessThan(spread);
  });

  it('corroborates the minimum reducer on a workload S10-b never measured', () => {
    // S10-b chose the minimum over the median on core-only runner data. This is an independent
    // check on a completely different process tree: if the minimum were merely an artifact of
    // that workload, the substrate's batches are where it would show.
    const mins = SUBSTRATE_FLOOR_BATCHES.map(minOf);
    const medians = SUBSTRATE_FLOOR_BATCHES.map(medianOf);
    const spreadOf = (v: number[]) => Math.max(...v) - Math.min(...v);
    expect(spreadOf(mins)).toBeLessThan(spreadOf(medians));
  });

  it('is stated for the developer class only, because no runner has measured it', () => {
    // G-RSS-IDLE needed a ci-runner limit roughly 3x its developer one. Publishing a
    // developer-derived limit under the runner class is the failure that reds a clean CI build
    // and teaches people to re-run it.
    expect(Object.keys(gate.limits)).toEqual(['developer']);
  });
});

describe('S10-d acquisition pair — re-derived against the measured 764, not the spec’s 535', () => {
  const { substrateMiB, modelsMiB, browserEngineMiB } = SUBSTRATE_ONLY_ACQUISITION;

  it('the spec’s desktop limit of 320 reds at baseline over the whole-acquisition artifact', () => {
    // WHY this is a test and not a note: 320 was derived as "296 substrate + headroom" while
    // acquisition was believed to be the browser engine alone. The 218 MiB of ranking and
    // embedding models is tier-INDEPENDENT — no browser rung stops warmup downloading a
    // reranker — so a correct post-S10-d desktop run lands ~518 and fails a gate with no
    // regression present. Same error class as the spec's G-DIET 670.
    expect(substrateMiB + modelsMiB).toBeGreaterThan(320);
  });

  it('the spec’s headless `== 0` reds at baseline for a host that acquired no substrate at all', () => {
    // A no-display host still downloads the models. Stated over the whole artifact, "zero" is
    // false for a machine doing exactly the right thing.
    expect(modelsMiB).not.toBe(0);
  });

  it('a substrate-scoped 320 keeps real headroom over the measured substrate', () => {
    // The fix is a narrower artifact, not a bigger number: scoped to the substrate alone, the
    // spec's own 320 works and `== 0` becomes both exact and achievable.
    expect(substrateMiB).toBeLessThan(320);
    expect((320 - substrateMiB) / substrateMiB).toBeGreaterThan(0.05);
  });

  it('the doubling regression D1 fears still reds the whole-acquisition gate, which is why it is kept', () => {
    // Acquiring the substrate AND the browser engine is the failure amended-D1 exists to
    // prevent. Narrowing the tier-conditional pair to the substrate would stop seeing it, so
    // this gate has to survive S10-d rather than be replaced by it.
    expect(evaluate(GATES['G-ACQUIRE'], substrateMiB + browserEngineMiB + modelsMiB).pass).toBe(false);
    expect(evaluate(GATES['G-ACQUIRE'], substrateMiB + modelsMiB).pass).toBe(true);
  });
});

/**
 * Real per-run floors from GitHub macos-latest, two batches of three, recorded by S10-a. The
 * runner is a different machine class from the developer Mac by roughly 4x on the same
 * statistic over the same horizon — which is the entire reason a single limit cannot serve
 * both.
 */
const RUNNER_FLOOR_BATCHES = [
  [163.5, 163.0, 162.8],
  [163.4, 196.3, 166.1],
  // Taken by the blocking gate itself, on two consecutive commits of S10-b that differ only in
  // comments and a test-file path helper. The fourth is the case the reducer exists for: two of
  // three runs never decayed inside the horizon.
  [162.8, 194.8, 162.8],
  [163.4, 192.3, 192.3],
];

describe('machine classes', () => {
  it('applies a per-class limit where a gate declares one, and the shared limit where it does not', () => {
    expect(limitFor(GATES['G-RSS-IDLE'], 'developer')).toBe(55);
    expect(limitFor(GATES['G-RSS-IDLE'], 'ci-runner')).toBe(185);
    // G-COLD-START needs no split: the runner measured 828 ms against a 1500 ms bound, so one
    // limit covers both classes and inventing a second would be inventing a number.
    expect(limitFor(GATES['G-COLD-START'], 'developer')).toBe(limitFor(GATES['G-COLD-START'], 'ci-runner'));
  });

  it('rejects an unknown class instead of falling back to the default', () => {
    // WHY: a typo in a CI argument would otherwise apply the developer limit to a runner, red
    // a clean build, and present as a regression. Failing loudly costs one line; the silent
    // fall-back costs an afternoon of bisecting a build that was never broken.
    expect(() => limitFor(GATES['G-RSS-IDLE'], 'laptop')).toThrow(/unknown machine class/);
    expect(MACHINE_CLASSES).toContain('ci-runner');
  });

  it('prints the class next to the number, so a red is never ambiguous about which limit it failed', () => {
    const out = renderReport(GATES['G-RSS-IDLE'], 200, { pass: false, machineClass: 'ci-runner' });
    expect(out).toContain('ci-runner');
    expect(out).toContain('<= 185 MiB');
  });

  it('would red a clean CI build under the developer limit — which is why the split exists', () => {
    // The control for the whole machine-class idea. If a runner-class measurement passed the
    // developer limit, there would be nothing here to solve.
    const cleanRunnerFloor = minimum(RUNNER_FLOOR_BATCHES[0]);
    expect(evaluate(GATES['G-RSS-IDLE'], cleanRunnerFloor, 'developer').pass).toBe(false);
    expect(evaluate(GATES['G-RSS-IDLE'], cleanRunnerFloor, 'ci-runner').pass).toBe(true);
  });
});

describe('the cross-run reducer for idle RSS is the minimum, not the median', () => {
  it('is steadier across batches than the median on the same runner data', () => {
    // The spread is what a threshold has to clear, so a steadier reducer is directly a wider
    // window to choose one from. Over four real batches: the minimum moves 0.6 MiB and the
    // median moves 29.5 — on a build whose only changes between two of those batches were
    // comments and a test-file path helper.
    const mins = RUNNER_FLOOR_BATCHES.map((b) => minimum(b) as number);
    const medians = RUNNER_FLOOR_BATCHES.map((b) => median(b) as number);
    const spread = (xs: number[]) => Math.max(...xs) - Math.min(...xs);
    expect(spread(mins)).toBeCloseTo(0.6, 5);
    expect(spread(medians)).toBeGreaterThan(29);
    expect(spread(mins)).toBeLessThan(spread(medians));
  });

  it('would have let a median gate swing 29.5 MiB between two comment-only commits', () => {
    // The concrete failure, not a projection. Batch 3's median is 162.8 and batch 4's is 192.3.
    // Any blocking median gate has to sit above 192.3 AND below 162.8 + 40 = 202.8 — a 10 MiB
    // window that only exists because these particular batches came out this way, and that no
    // future batch is obliged to respect. The minimum sits at 163.4 in the same run.
    const [, , batch3, batch4] = RUNNER_FLOOR_BATCHES;
    expect(median(batch3)).toBe(162.8);
    expect(median(batch4)).toBe(192.3);
    expect(minimum(batch4)).toBe(163.4);
    // The shipped gate passes batch 4; a median-reduced one at the same limit would not.
    expect(evaluate(GATES['G-RSS-IDLE'], minimum(batch4), 'ci-runner').pass).toBe(true);
    expect(evaluate(GATES['G-RSS-IDLE'], median(batch4), 'ci-runner').pass).toBe(false);
  });

  it('loses no sensitivity: a 40 MiB retained allocation raises every run, so it raises the minimum', () => {
    // The obvious objection to a minimum is that it discards evidence. It does not discard the
    // evidence that matters here: retained bytes cannot be collected, so they raise the true
    // floor and therefore every run's floor. Modelled by adding the leak to each run.
    for (const batch of RUNNER_FLOOR_BATCHES) {
      const leaked = batch.map((f) => f + 40);
      expect(evaluate(GATES['G-RSS-IDLE'], minimum(batch), 'ci-runner').pass).toBe(true);
      expect(evaluate(GATES['G-RSS-IDLE'], minimum(leaked), 'ci-runner').pass).toBe(false);
    }
  });

  it('is not fooled by a run that never decayed inside the horizon', () => {
    // 196.3 is not a heavier idle footprint, it is a looser upper bound — the process simply
    // had not finished decaying at 45 s. A median carries that artifact into the number; the
    // minimum discards it for the right reason.
    expect(minimum([163.4, 196.3, 166.1])).toBe(163.4);
    expect(median([163.4, 196.3, 166.1])).toBe(166.1);
  });

  it('rejects an empty series', () => {
    expect(() => minimum([])).toThrow(/empty/);
  });

  it('is the reducer the runner actually reports with, not merely the one exported', async () => {
    // WHY: everything above tests the reducer in isolation. The runner could still call
    // `median(floors)` and every one of those tests would stay green — which is the shape of
    // check that can only agree with what it checks. `measure.mjs` cannot be unit-tested
    // (it spawns servers and installs packages), so its CHOICE is asserted at the source.
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(new URL('../../scripts/budget/measure.mjs', import.meta.url), 'utf8');
    const call = src.match(/report\('G-RSS-IDLE',\s*(\w+)\(/);
    expect(call?.[1]).toBe('minimum');
    // Control: the same regex finds the OTHER median-reduced gate, so a match here means the
    // pattern works and G-RSS-IDLE really did opt out of it.
    expect(src).toMatch(/report\('G-COLD-START',\s*median\(/);
  });
});

describe("S10-d's tier-conditional pair is scoped to the COMPONENT, not the total", () => {
  const desktop = GATES['G-ACQUIRE-SUBSTRATE-DESKTOP'];
  const headless = GATES['G-ACQUIRE-SUBSTRATE-HEADLESS'];

  it('states both gates over the component directory alone', () => {
    // WHY THE ARTIFACT IS THE FIX AND NOT THE NUMBER. The spec states `<=320` and `==0` over the
    // FULL acquisition set, and both are unreachable there: 218 MiB of that set is ranking and
    // embedding models, and no browser rung stops warmup downloading a reranker. A clean desktop
    // run would total 300 + 218 = 518 and red a `<=320`; a clean no-display run would total 218
    // and red an `==0` for behaving perfectly. Same error class as the spec's G-DIET 670 — a
    // threshold derived from one line item and then asserted over a total.
    for (const gate of [desktop, headless]) {
      expect(gate.artifact).toMatch(/substrate/i);
      expect(gate.artifact).not.toMatch(/ms-playwright|models/);
    }
    // Control: the gate this pair REPLACES is stated over the full set, so the assertion above
    // is discriminating rather than true of every gate in the file.
    expect(GATES['G-ACQUIRE'].artifact).toMatch(/each acquisition directory/);
  });

  it('would red on a clean run if either were stated over the full acquisition set', () => {
    // The arithmetic that condemns the spec's version, asserted rather than described.
    const { substrateMiB, modelsMiB } = SUBSTRATE_ONLY_ACQUISITION;
    expect(evaluate(desktop, substrateMiB + modelsMiB).pass).toBe(false);
    expect(evaluate(headless, modelsMiB).pass).toBe(false);
    // Scoped to the component alone, both are reachable — which is the whole correction.
    expect(evaluate(desktop, substrateMiB).pass).toBe(true);
    expect(evaluate(headless, 0).pass).toBe(true);
  });

  it('keeps the headless gate EXACT, because "zero" is the claim', () => {
    // WHY: D-S10-5 says a no-display host acquires zero component bytes — not "few", not "less".
    // Restating it as `<= some small number` would be a different, weaker claim, and it is
    // exactly the loosening a red would tempt someone into.
    expect(headless.comparison).toBe('==');
    expect(headless.limit).toBe(0);
    expect(evaluate(headless, 1).pass).toBe(false);
  });

  it('keeps ~6.7% headroom over the measured component on the desktop gate', () => {
    expect(desktop.limit).toBe(320);
    expect(evaluate(desktop, SUBSTRATE_ONLY_ACQUISITION.substrateMiB).pass).toBe(true);
    expect(evaluate(desktop, 321).pass).toBe(false);
  });

  it('is a DIFFERENTIAL: the two arms measure the same artifact and differ only in tier', () => {
    // WHY: read alone, `<=320` passes trivially on a host that acquired nothing at all — the
    // self-satisfaction failure. The claim is carried by the pair, so the pair must be measuring
    // the same thing. If these ever diverge, the two arms stop being comparable and each becomes
    // a number about a different quantity.
    expect(headless.artifact).toMatch(/identical to G-ACQUIRE-SUBSTRATE-DESKTOP/);
    expect(desktop.statistic).toBe(headless.statistic);
    expect(desktop.unit).toBe(headless.unit);
  });

  it('leaves G-ACQUIRE over the full artifact, where it still prices the models', () => {
    // WHY KEEP IT: it is the only gate that charges anyone for the 218 MiB of models, and it is
    // what catches amended-D1's doubling regression — acquiring the component AND the engine.
    const { substrateMiB, modelsMiB, browserEngineMiB } = SUBSTRATE_ONLY_ACQUISITION;
    expect(GATES['G-ACQUIRE'].limit).toBe(800);
    expect(evaluate(GATES['G-ACQUIRE'], substrateMiB + modelsMiB).pass).toBe(true);
    expect(evaluate(GATES['G-ACQUIRE'], substrateMiB + modelsMiB + browserEngineMiB).pass).toBe(false);
  });

  it('reports the protocol alongside the number for both new gates', () => {
    for (const gate of [desktop, headless]) {
      const text = renderReport(gate, 0, { pass: true });
      expect(text).toContain(gate.artifact);
      expect(text).toContain(gate.statistic);
      expect(text).toContain(gate.baseline);
    }
  });
});

describe('G-TOTAL-DESKTOP is dropped, not silently inherited', () => {
  it('ships no gate under that name', () => {
    // WHY: the spec's <=1000 is unreachable in either world — 1464 today, 1218 after the flip —
    // and it was never shipped. Inheriting it would red a clean build with no regression present.
    expect(GATES['G-TOTAL-DESKTOP']).toBeUndefined();
  });

  it('records the arithmetic that makes a composed gate unbuildable today', () => {
    // WHY A DECISION AND NOT A DELETION: G-DIET (<=515) and G-ACQUIRE (<=800) already bound the
    // composed total at 1315 whether or not anything asserts it, and the lowest value the
    // composition can currently take is 1271. So a composed gate could only fail inside a 44 MiB
    // window, against a sum of two measurements each carrying tens of MiB of transitive churn —
    // a threshold finer than the resolution of its own data, which is the same arithmetic that
    // rejected a median reducer for G-RSS-IDLE and keeps G-RSS-SUBSTRATE report-only.
    //
    // S10-e re-derived these because it moved `node_modules` from 700 to 685; the platform prune
    // re-derived them again, moving it from 685 to 507. THIS ASSERTION IS WHY BOTH HAPPENED — it
    // fails the moment a slice changes one input and leaves the composed arithmetic describing a
    // tree that no longer exists, and it did exactly that on this slice's first run (1315 against
    // a stale 1493). The window is 44 MiB in both derivations because it is the sum of each
    // gate's own headroom (8 + 36), which this slice preserved deliberately rather than by luck.
    const d = G_TOTAL_DESKTOP_DROPPED;
    expect(limitFor(GATES['G-DIET']) + limitFor(GATES['G-ACQUIRE'])).toBe(d.jointBoundOfShippedGatesMiB);
    expect(d.jointBoundOfShippedGatesMiB - d.measuredTodayMiB).toBe(44);
    // And it is a deferral: once the desktop arm acquires a real component the window opens.
    expect(d.reDeriveAtMiB).toBeGreaterThan(d.measuredPostFlipMiB);
    expect(d.reDeriveAtMiB).toBeLessThan(d.measuredTodayMiB);
  });
});

describe('G-RSS-SUBSTRATE stays report-only', () => {
  it('is not wired as a blocking step, and its limit is unchanged at 510', async () => {
    // WHY S10-d DOES NOT PROMOTE IT: the minimum-of-floors across three batches spans 21.0
    // (457.5/464.9/478.5), so a 40 MiB blocking gate needs a limit above 478.5 and below
    // 457.5+40=497.5 — a 19 MiB window, NARROWER THAN THE SPREAD ITSELF. It also has no
    // ci-runner observation and cannot run on `clean-machine-smoke`, which installs the
    // published package while the only component that exists is the apps/studio checkout.
    expect(GATES['G-RSS-SUBSTRATE'].limit).toBe(510);
    const { readFile } = await import('node:fs/promises');
    const ci = await readFile(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
    expect(ci).not.toMatch(/measure\.mjs substrate-rss/);
    // Control: the sweep is reading the right file — the gates that DO block are in there.
    expect(ci).toMatch(/measure\.mjs idle-rss/);
  });
});

/*
 * G-ACQUIRE's measurement WINDOW, which is a different thing from its threshold.
 *
 * The gate is titled "bytes `warmup` downloads" and its old artifact said "differenced after
 * it". What the runner actually did was `du` the directories LIVE when the assertion ran —
 * three steps and ~3 minutes after warmup exited, with a live `wigolo fetch` and a live
 * `wigolo search` against the DEFAULT data directory in between. So cached web content was
 * being charged to warmup. Across the ten runs of the current tree the data component reads
 * 234-246 against a floor of 233 (216 MiB of models + 17 of browser driver): 1-13 MiB of
 * noise, on a gate whose last clean run passed at 793 against 800.
 *
 * These tests are stated over the WORKFLOW and the RUNNER SOURCE rather than over protocol.mjs
 * on purpose. The protocol object can describe any window it likes; only ci.yml and measure.mjs
 * decide which one is measured, and a gate whose stated artifact and executed artifact disagree
 * is precisely the failure this program keeps finding.
 */
describe("G-ACQUIRE's window closes when warmup exits, not when the assertion runs", () => {
  const ciYml = async () => {
    const { readFile } = await import('node:fs/promises');
    return readFile(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  };
  const measureSrc = async () => {
    const { readFile } = await import('node:fs/promises');
    return readFile(new URL('../../scripts/budget/measure.mjs', import.meta.url), 'utf8');
  };

  it('takes the closing snapshot before the step that fetches live web content', async () => {
    const ci = await ciYml();
    const after = ci.indexOf('acquire-snapshot "$RUNNER_TEMP/acquire-after.json"');
    const toolCalls = ci.indexOf('wigolo fetch https://example.com');
    const warmup = ci.indexOf('wigolo warmup --reranker --embeddings --json');
    expect(after).toBeGreaterThan(-1);
    expect(after).toBeGreaterThan(warmup);
    expect(after).toBeLessThan(toolCalls);
  });

  it('still asserts AFTER the tool calls, so an acquisition red cannot hide the pipeline check', async () => {
    // The other half of the constraint, and the reason the window moved instead of the step.
    // The runner uses `bash -e` and stops at the first failing step: moving the ASSERTION up
    // would mean a red acquisition costs the run its only proof that fetch/extract/search are
    // wired. Only the snapshot moved.
    const ci = await ciYml();
    const diff = ci.indexOf('measure.mjs" acquire-diff');
    const toolCalls = ci.indexOf('wigolo search \'typescript programming language\'');
    expect(diff).toBeGreaterThan(toolCalls);
  });

  it('passes both snapshots to the diff, so the assertion never re-measures live', async () => {
    // The wiring is the whole fix: `acquire-diff` still accepts one argument (a developer
    // running snapshot/warmup/diff by hand), so a CI invocation that quietly dropped the
    // second file would keep working and keep counting the tool calls.
    const ci = await ciYml();
    expect(ci).toMatch(/acquire-diff "\$RUNNER_TEMP\/acquire\.json" "\$RUNNER_TEMP\/acquire-after\.json"/);
  });

  it('prefers the recorded closing snapshot over a live `du` when one is given', async () => {
    const src = await measureSrc();
    expect(src).toMatch(/const now = after \? \(after\[key\]\?\.mib \?\? 0\) : duMiB\(path\)/);
    // Control: the live path still exists for the by-hand invocation, so the assertion above
    // is about which one is CHOSEN rather than about `duMiB` having been deleted.
    expect(src).toMatch(/function duMiB/);
  });

  it('says in the report which window was measured, because the two are not comparable', async () => {
    const src = await measureSrc();
    expect(src).toMatch(/window closed at the end of the measured step/);
    expect(src).toMatch(/window closed live at assertion time/);
  });

  it('attributes each directory delta to its child directories', async () => {
    // WHY: every drift observation this gate has produced is one number per directory, which
    // can show that something moved and can never say what. The pinned browser download is
    // chromium + chromium-headless-shell + ffmpeg and measures 534 MiB reproducibly off the
    // runner; a runner reading of 554 has to be attributable or it is unfalsifiable.
    const src = await measureSrc();
    expect(src).toMatch(/function childDeltas/);
    expect(src).toMatch(/childDeltas\(children, nowChildren\)/);
    expect(src).toMatch(/children: childrenMiB\(p\)/);
  });

  it('states the closing snapshot in the gate protocol, not just in the runner', async () => {
    // A protocol that describes a window the runner does not measure is how this gate came to
    // charge a live search to `warmup` for as long as it did.
    const gate = GATES['G-ACQUIRE'];
    expect(gate.artifact).toMatch(/second snapshot taken the instant warmup exits/i);
    expect(gate.artifact).toMatch(/never a live `du` at assertion time/);
    expect(gate.horizon).toMatch(/not the assertion/);
    // Control: the substrate pair's artifact makes no such claim, so this is discriminating.
    expect(GATES['G-ACQUIRE-SUBSTRATE-DESKTOP'].artifact).not.toMatch(/second snapshot/);
  });
});
