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
import {
  runFlowDrift,
  renderFlowDriftReport,
  runWrongElementProbe,
  runDegradationProbe,
  transitionLabel,
  G2,
  type FlowDriftReport,
} from '../../benchmarks/scrape-quality/flow-drift.js';
import { computeFingerprint, STABLE_ATTRS } from '../../src/studio/perception/id.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let cached: FlowDriftReport | undefined;
function report(): FlowDriftReport {
  if (!cached) cached = runFlowDrift();
  return cached;
}

// 3x the measured 8.0s file duration. Deliberately not larger: the repo default is 20s, and a ceiling
// set many multiples above observed cost cannot fail on a harness regression the default would catch.
const TIMEOUT = 60_000;

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

  it('buys NO additional reach on the five §3.4 classes, at the heal boundary OR at the resolver', () => {
    const r = report();
    // Asserted on BOTH arms. Only arm B would leave the cause ambiguous: a 0 there is produced either
    // by heal finding nothing or by §5.3 declining what it found, and those are different findings.
    expect(r.hOnly).toBe(0);
    expect(r.bOnly).toBe(0);
    expect(r.h.resolved - r.a.resolved).toBeLessThan(G2.minArmBAdvantage);
    expect(r.b.resolved - r.a.resolved).toBeLessThan(G2.minArmBAdvantage);
    // On THIS corpus the halt costs nothing, because heal never had to drop a tier.
    expect(r.haltedFromH).toBe(0);
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
    // Every arm named, and the two numbers a decision rests on present with their labels.
    expect(text).toContain('arm A  ref equality only');
    expect(text).toContain('arm H  heal boundary');
    expect(text).toContain('arm B  shipped resolver');
    expect(text).toContain('REACH');
    expect(text).toContain('halted by the §5.3 degradation rule');
    expect(text).toContain('must-refuse controls');
    expect(text).toContain('DIFFERENT element');
  }, TIMEOUT);
});

describe('G2 — what the C0 corpus CANNOT produce, constructed so the rows mean what they say', () => {
  it('arm A lands on a DIFFERENT element where the corpus only ever shows it landing on the right one', () => {
    // Two links sharing an accessible name in one <tbody>, differing only by href, under
    // `sibling_reorder`. The C0 corpus reports `firedDifferentElement == 0` because its mutations
    // preserve positional paths, so arm A fires there only when the ref still designates the same
    // node. Without this probe, "arm A over-fires" could not be distinguished from "arm A is fine".
    const p = runWrongElementProbe();
    expect(p.fingerprintCollides).toBe(true);
    expect(p.armAResolved).toBe(true);
    expect(p.armARecordedIdentity).toBe('link|Open order|/row-ONE');
    expect(p.armAResolvedIdentity).toBe('link|Open order|/row-TWO');
    expect(p.armALandedOnDifferentElement).toBe(true);
    // arm B refuses at the point of ambiguity, which is the only thing that catches this.
    expect(p.armBResolved).toBe(false);
    expect(p.armBReason).toBe('ambiguous_target');
    expect(p.armBConfidence).toBe('low');
    expect(p.armBCandidates).toBe(2);
  }, TIMEOUT);

  it('on the C0 corpus, every one of arm A\'s firings landed on the INTENDED element', () => {
    // Stated as its own row so the must-refuse count is never read as N wrong clicks. Arm A resolved
    // targets it could not know were safe; on this corpus none was observably wrong.
    const r = report();
    expect(r.mustRefuse.firedDifferentElement).toBe(0);
    expect(r.mustRefuse.firedSameElement).toBe(r.mustRefuse.ambiguousAFired);
  }, TIMEOUT);

  it('reports the EFFECTIVE sample behind the ambiguous cases, not just the replay count', () => {
    // 5 mutations x N shapes: the same shape replayed five times is five cases and one sample.
    const r = report();
    expect(r.mustRefuse.ambiguousDistinctShapes).toBeGreaterThan(0);
    expect(r.mustRefuse.ambiguousDistinctShapes).toBeLessThan(r.mustRefuse.ambiguousCases);
  }, TIMEOUT);
});

describe('G2 — §5.3\'s degradation halt is what caps the reach row', () => {
  it('heal RECOVERS a drifted stable attr at medium, and the resolver then declines it', () => {
    // The decisive decomposition. The record tier is MEASURED (`high`, because a recordable target is
    // uniquely fingerprinted on its own page), heal drops to `medium`, and §5.3 halts on worse-than-
    // recorded. So every reach gain healing can produce is converted into a halt, and G2's reach
    // threshold is unreachable while that rule stands — a property of the ruling, not of the corpus.
    const p = runDegradationProbe();
    expect(p.fingerprintChanged).toBe(true);
    expect(p.roleNameHeld).toBe(true);
    expect(p.tierAtRecord).toBe('high');
    expect(p.healResolved).toBe(true);
    expect(p.healConfidence).toBe('medium');
    expect(p.armAResolved).toBe(false);
    expect(p.armBResolved).toBe(false);
    expect(p.armBReason).toBe('confidence_degraded');
  }, TIMEOUT);

  it('proves the heal-tier distribution CAN express high->medium, so its C0 value is a measurement', () => {
    // The distribution used to be bucketed from the RESOLVER's refusal reasons, where a medium recovery
    // surfaces as `confidence_degraded` and landed in the `none` bucket — so `high->medium` was
    // unreachable for every corpus and the C0 reading of it was vacuous. Asserted on the label the
    // shared deriver produces, which is the same code path the corpus loop uses, so a regression to
    // resolver-bucketing reds here rather than silently flattening the distribution again.
    const p = runDegradationProbe();
    expect(p.transitionLabel).toBe('high->medium');
    expect(transitionLabel('high', { resolved: true, ref: 'e1', role: 'link', confidence: 'medium' })).toBe('high->medium');
    // And the resolver's own verdict on the same case is NOT the tier — the two must not be conflated.
    expect(p.armBReason).toBe('confidence_degraded');
  }, TIMEOUT);

  it('keeps the record tier a MEASUREMENT of the page, not a constant', () => {
    // The pin this slice removed has no signature in the C0 numbers (every recordable target is uniquely
    // fingerprinted, so the measured value IS 'high'). Guarded structurally instead: the call site must
    // not pass a tier literal, or the reach comparison silently becomes a theorem again.
    const src = readFileSync(join(process.cwd(), 'benchmarks/scrape-quality/flow-drift.ts'), 'utf-8');
    const storeSeeds = src.slice(src.indexOf('function storeSeeds'), src.indexOf('// The arms'));
    expect(storeSeeds).toContain('healTierAtRecord: recordTier(');
    expect(storeSeeds).not.toContain("healTierAtRecord: 'high'");
    expect(storeSeeds).not.toContain("healTierAtRecord: 'medium'");
  }, TIMEOUT);
});
