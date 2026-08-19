/**
 * S13-1 exit gate (G2) — does healing actually beat what the audit already permits?
 *
 * Two arms over identical cases (`benchmarks/scrape-quality/flow-drift.ts`): arm A matches the
 * recorded ref string against refs recomputed on the drifted page — the resolver `studio_audit` alone
 * supports — and arm B runs the shipped `resolveFlowStep` (seed → `heal` tiers 1–3 → ref). Offline and
 * deterministic: frozen C0 pages through `drift.ts`'s mutation engine, no browser and no network.
 *
 * The gate's two rows point in OPPOSITE directions on this corpus, and the assertions below are split
 * to keep both visible rather than collapsing them into one verdict:
 *  - REACH: arm B resolves no more than arm A, because none of the five §3.4 mutation classes perturbs
 *    a fingerprint, so tier 1 carries every case and tiers 2–3 are never reached.
 *  - SAFETY: on cases that must be REFUSED, arm A returns a ref for a large fraction and arm B for
 *    none. So the seed apparatus buys correct refusal, which is the half the reach threshold cannot see.
 */
import { describe, it, expect } from 'vitest';
import { runFlowDrift, renderFlowDriftReport, G2, type FlowDriftReport } from '../../benchmarks/scrape-quality/flow-drift.js';
import { computeFingerprint, STABLE_ATTRS } from '../../src/studio/perception/id.js';

let cached: FlowDriftReport | undefined;
function report(): FlowDriftReport {
  if (!cached) cached = runFlowDrift();
  return cached;
}

const TIMEOUT = 180_000;

describe('G2 — the corpus is big enough, and its oracle is sound', () => {
  it(`runs at least ${G2.minCases} cases over a non-empty seed set`, () => {
    const r = report();
    // Both halves asserted: a corpus of 0 seeds would satisfy every count row below vacuously.
    expect(r.seeds).toBeGreaterThan(0);
    expect(r.fixturesWithSeeds).toBeGreaterThan(0);
    expect(r.cases).toBeGreaterThanOrEqual(G2.minCases);
  }, TIMEOUT);

  it("holds the oracle's premise: no mutation removes an interactive element", () => {
    // Checked on the raw HTML, so this cannot be satisfied by the same truncation behaviour that
    // shapes the snapshot the arms are scored through.
    expect(report().mutationPreservesRawElements).toBe(true);
  }, TIMEOUT);

  it('carries a non-empty must-REFUSE set, so the over-firing row can fail at all', () => {
    // Without this the "wrong resolutions" row is vacuous: a corpus of only-must-resolve cases cannot
    // catch over-firing, and over-firing is the silent-wrong failure G2's binding half exists to detect.
    const r = report();
    expect(r.mustRefuse.cases).toBeGreaterThan(0);
    // Both kinds, asserted separately: an ABSENT identity has no ref on any page, so arm A refuses it
    // trivially. Only the AMBIGUOUS half can distinguish the arms, so a total count alone could be
    // satisfied entirely by cases neither arm can get wrong.
    expect(r.mustRefuse.absentCases).toBeGreaterThan(0);
    expect(r.mustRefuse.ambiguousCases).toBeGreaterThan(0);
    expect(r.mustRefuse.cases).toBe(r.mustRefuse.absentCases + r.mustRefuse.ambiguousCases);
  }, TIMEOUT);

  it('shows arm A over-fires ONLY on the ambiguous half, which localises the failure mode', () => {
    // An identical-sibling run shares a role, so role comparison cannot detect this: arm A returns a
    // confident ref for one member of a run it cannot tell apart. Refusing at the point of ambiguity
    // is the only thing that catches it — which is what `heal` does and ref equality cannot.
    const r = report();
    expect(r.mustRefuse.absentAFired).toBe(0);
    expect(r.mustRefuse.ambiguousAFired).toBeGreaterThan(0);
    expect(r.mustRefuse.aFired).toBe(r.mustRefuse.ambiguousAFired);
  }, TIMEOUT);
});

describe('G2 — SAFETY: arm B never resolves a target it should refuse', () => {
  it('returns EXACTLY 0 refs on must-refuse cases', () => {
    // The binding row. An automated wrong click is the worst outcome available to S13.
    expect(report().mustRefuse.bFired).toBe(0);
  }, TIMEOUT);

  it('resolves EXACTLY 0 cases to an element whose role differs from the recorded role', () => {
    expect(report().b.wrong).toBe(0);
  }, TIMEOUT);

  it('records that arm A — the exact-replay fallback — DOES over-fire, which is the finding', () => {
    // Not a threshold on arm A: the number is evidence that "exact-replay-only", the outcome the reach
    // row would send S13 to, is the arm that produces wrong resolutions. Asserted as > 0 so that if a
    // future corpus change makes arm A clean, this reds and the recommendation gets re-derived.
    const r = report();
    expect(r.mustRefuse.aFired).toBeGreaterThan(0);
    expect(r.mustRefuse.aFired).toBeGreaterThan(r.mustRefuse.bFired);
  }, TIMEOUT);
});

describe('G2 — REACH: the measured advantage, and why it is what it is', () => {
  it('resolves everything arm A resolves — a case arm A wins and arm B loses is a resolver BUG', () => {
    // Recorded as its own row precisely so it cannot be read as a tradeoff (spec §8, G2 row 3).
    expect(report().aOnly).toBe(0);
    expect(report().b.resolved).toBeGreaterThanOrEqual(report().a.resolved);
  }, TIMEOUT);

  it('buys NO additional reach on the five §3.4 classes, because every one preserves the fingerprint', () => {
    const r = report();
    expect(r.bOnly).toBe(0);
    expect(r.b.resolved - r.a.resolved).toBeLessThan(G2.minArmBAdvantage);
    // The mechanism, not just the count: tier 1 carries every case, so no transition degrades.
    expect(Object.keys(r.tierTransitions)).toEqual(['high->high']);
  }, TIMEOUT);

  it('explains the 0 structurally: for a seed with no stable attr, tier 2 keys on tier 1 data', () => {
    // `computeFingerprint` is role + name + a fixed 3-attr slice. With that slice empty the fingerprint
    // carries nothing tier 2 (role+name) does not, so tier 2 can never recover what tier 1 missed —
    // and 2/3 of recordable seeds are in that state. This is a property of the shipped hash, asserted
    // here directly rather than inferred from the benchmark's own output.
    const bare = computeFingerprint({ role: 'link', name: 'Next page', attrs: {} });
    const withVolatileOnly = computeFingerprint({ role: 'link', name: 'Next page', attrs: { class: 'x', id: 'y', 'data-v': 'z' } });
    expect(bare).toBe(withVolatileOnly);
    expect(bare).toBe(computeFingerprint({ role: 'link', name: 'Next page' }));
    expect(STABLE_ATTRS).toEqual(['type', 'name', 'placeholder']);
    expect(report().seedsWithoutStableAttrs).toBeGreaterThan(0);
  }, TIMEOUT);
});

describe('G2 — the heal-tier transition distribution (§11.A.6)', () => {
  it('accounts for every case, so the distribution cannot hide one', () => {
    const r = report();
    const total = Object.values(r.tierTransitions).reduce((a, b) => a + b, 0);
    expect(total).toBe(r.cases);
  }, TIMEOUT);

  it('shows high->medium is NOT the common transition on this corpus, so §5.3 halt-on-worse stands', () => {
    // The risk §5.3 names: if degrading a tier were the common case, halting would break every flow on
    // the first redesign. It is 0 here — but only because no §3.4 class perturbs a fingerprint, so this
    // is weak evidence for the ruling rather than a vindication of it.
    const r = report();
    const degraded = r.tierTransitions['high->medium'] ?? 0;
    expect(degraded).toBeLessThan(r.cases / 2);
  }, TIMEOUT);

  it('renders a report a decision-maker can read', () => {
    const text = renderFlowDriftReport(report());
    expect(text).toContain('arm B advantage');
    expect(text).toContain('must-refuse controls');
  }, TIMEOUT);
});
