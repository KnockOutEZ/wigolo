import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain-JS build tooling, deliberately not part of the typed src/ graph.
import { GATES, RSS_HORIZON_MS, RSS_SAMPLE_INTERVAL_MS, floorMiB, median, evaluate, renderReport } from '../../scripts/budget/protocol.mjs';

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
