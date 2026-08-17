/**
 * S11a INVERSION PROBES — the outside signal G-S11a-1 did not have.
 *
 * The S11 spec (`2026-08-10-s11-visual-v1-spec.md:475-478`) requires four of them, verbatim:
 *
 *   "Inversion probes for S11a (must be run, each must red): return a constant vector (G-S11a-1
 *    must red); skip the DPR/viewport normalisation (the cross-viewport clause must red); replace
 *    the one-shot harvest with the per-node loop (G-S11a-2 must red); remove the D5 clamp and feed
 *    a hostile 10^9-px box (the clamp test must red)."
 *
 * WHY THIS FILE EXISTS. G-S11a-1 was measured at 96.7% and reported as a pass. A metric scored only
 * against itself agrees with itself by construction, so that number alone does not distinguish "the
 * signature separates pages" from "the scoring cannot tell the difference". Each probe below
 * DELIBERATELY BREAKS the signature in one specific way and asserts BOTH directions:
 *
 *   - the REAL signer still clears the gate — this half reds if someone guts the signature;
 *   - the MUTANT signer does NOT — this half reds if the probe has lost its teeth, which is the
 *     failure mode the spec names ("a probe that reports green while perturbing nothing").
 *
 * A one-directional probe is worthless: a gate that a mutant also passes has not been inverted, it
 * has been re-confirmed. Every number asserted here was cross-checked against a LIVE mutation of
 * `src/studio/layout/signature.ts` (reverted; the shipped tree is unchanged) so the surrogates below
 * are known to reproduce the real thing rather than merely resemble it.
 *
 * INHERITED LIMIT, STATED NOT PAPERED OVER. The corpus is SYNTHETIC (`benchmarks/visual/synth.ts:1-23`)
 * and that file is explicit that a pass on it is NOT evidence G-S11a-1 holds on the web. These probes
 * inherit that limit exactly. What they establish is narrower and still worth having: the metric is
 * DOING the work each mutation removes, and the gate's scoring can distinguish a working signature
 * from a broken one. They do not promote G-S11a-1 from "passes on generated input" to "passes".
 */
import { describe, it, expect } from 'vitest';
import {
  computeLayoutSignature,
  layoutDistance,
  serializeLayoutSignature,
  MAX_LAYOUT_COORD_PX,
  type LayoutBox,
  type LayoutInput,
  type LayoutSignature,
} from '../../../../src/studio/layout/signature.js';
import { harvestLayout, type LayoutCdp } from '../../../../src/studio/layout/harvest.js';
import {
  scoreSeparation,
  scoreCrossViewport,
  scoreDprExact,
  signerAt,
  DESKTOP_WIDTH,
} from '../../../../benchmarks/visual/score.js';
import {
  constantSigner,
  noDprSigner,
  noWidthNormSigner,
  scaleInput,
  unclampWindowHolds,
  unclampedSignature,
  UNCLAMP_SCALE,
} from '../../../../benchmarks/visual/mutants.js';
import { buildCorpus, layoutPage } from '../../../../benchmarks/visual/synth.js';

/** G-S11a-1 clause 1's bar. */
const SEPARATION_BAR = 95;
/** G-S11a-1 clause 2's bar. */
const CROSS_VIEWPORT_BAR = 90;
/**
 * The second viewport width the cross-viewport clause is exercised at. The spec never states HOW MUCH
 * narrower the second viewport is, and the shipped runner shows the verdict is entirely determined by
 * that unstated number (100% at 1152, 30% at 720). 1152 is used here for one reason only: an
 * inversion probe needs a gate that is GREEN before the mutation, or there is nothing to invert. It is
 * NOT a claim that 1152 is the right width, and nothing here is tuned to make a gate pass — the width
 * sweep is asserted below so the choice cannot quietly become a threshold.
 */
const PROBE_WIDTH = 1152;

const cells = (s: LayoutSignature) => Array.from(s.cells).join();
const box = (x: number, y: number, width: number, height: number, textLength = 0): LayoutBox =>
  ({ x, y, width, height, textLength });
const VP = { width: 1200, height: 900, devicePixelRatio: 1 };

function threeColumn(): LayoutInput {
  const boxes: LayoutBox[] = [box(0, 0, 1200, 80, 40)];
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 3; col++) boxes.push(box(20 + col * 400, 100 + row * 220, 360, 200, 180));
  }
  boxes.push(box(0, 1000, 1200, 120, 60));
  return { boxes, viewport: VP };
}

function docsPage(): LayoutInput {
  const boxes: LayoutBox[] = [];
  for (let i = 0; i < 30; i++) boxes.push(box(0, i * 30, 240, 26, 22));
  for (let i = 0; i < 8; i++) boxes.push(box(280, 40 + i * 110, 880, 96, 420));
  return { boxes, viewport: VP };
}

/** The one shape in which the viewport floor of the extent normalisation binds — see probe 2. */
function loginCard(): LayoutInput {
  return {
    boxes: [
      box(450, 300, 300, 240, 0), box(470, 320, 260, 40, 12), box(470, 380, 260, 36, 8),
      box(470, 430, 260, 36, 8), box(470, 480, 260, 40, 6),
    ],
    viewport: VP,
  };
}

const real = signerAt();

describe('S11a inversion probes — the probes are scored by the GATE\'S OWN arithmetic, not a second copy of it', () => {
  it('scores the same corpus, the same pair count and the same verdict the shipped gate was reported from', () => {
    // If the probes scored a different corpus than `benchmarks/visual/runner.ts`, a red probe would
    // say nothing about the gate that was actually reported. 435 = C(30,2), the pair count the p5 in
    // the reported result was taken over.
    const s = scoreSeparation(real);
    expect(s.pairs).toBe(435);
    expect(s.separatedPct).toBeGreaterThanOrEqual(SEPARATION_BAR);
    // The reported gate was scored at 8x10 as well as the shipped 12x16; both must be green, or the
    // probes below are inverting a gate that was already red.
    expect(scoreSeparation(signerAt(8, 10)).separatedPct).toBeGreaterThanOrEqual(SEPARATION_BAR);
  });
});

/* ------------------------------------------------------------------ *
 * PROBE 1 — "return a constant vector (G-S11a-1 must red)"
 * ------------------------------------------------------------------ */

describe('PROBE 1 — a constant vector must red G-S11a-1', () => {
  it('collapses clause 1 from a pass to zero: every same-page distance ties the different-page p5 instead of falling below it', () => {
    const before = scoreSeparation(real);
    const after = scoreSeparation(constantSigner());
    expect(before.separatedPct).toBeGreaterThanOrEqual(SEPARATION_BAR);
    // Not "lower" — ZERO. A constant makes every distance 0, so the p5 is 0 too and no same-page pair
    // can be STRICTLY below it. Both bands collapse onto each other, which is exactly the mechanism
    // the spec cites when it says the gate cannot be satisfied by a constant.
    expect(after.separatedPct).toBe(0);
    expect(after.crossP5).toBe(0);
    expect(after.samePageP50).toBe(0);
  });

  it('collapses clause 2 to zero at every width, including the one where the real signer scores 100%', () => {
    for (const width of [PROBE_WIDTH, 1024, 720]) {
      expect(scoreCrossViewport(constantSigner(), width).inBandPct).toBe(0);
    }
    expect(scoreCrossViewport(real, PROBE_WIDTH).inBandPct).toBeGreaterThanOrEqual(CROSS_VIEWPORT_BAR);
  });

  it('is INVISIBLE to the DPR-exactness clause — that clause alone can never stand in for the separation gate', () => {
    // A constant is trivially invariant to device pixel ratio, so the DPR column reports a perfect
    // score for a signature that carries no information at all. Recorded as a pin because a reviewer
    // reading "dprExact 100%" next to a separation number has two readings available and only one of
    // them is safe: DPR-exactness is an insufficient-alone predicate.
    expect(scoreDprExact(constantSigner())).toBe(100);
    expect(scoreDprExact(real)).toBe(100);
  });
});

/* ------------------------------------------------------------------ *
 * PROBE 2 — "skip the DPR/viewport normalisation (the cross-viewport clause must red)"
 *
 * D3 names TWO normalisations — "normalised by viewport width and device pixel ratio" — and the spec
 * names ONE gate for both. They do not behave the same way, so they are probed separately and the
 * mismatch is asserted rather than glossed.
 * ------------------------------------------------------------------ */

describe('PROBE 2 — skipping the normalisation', () => {
  it('DPR half: the invariance the signature claims is real, and removing the division breaks it', () => {
    const css = loginCard();
    const devicePx: LayoutInput = {
      boxes: css.boxes.map((b) => ({ x: b.x * 2, y: b.y * 2, width: b.width * 2, height: b.height * 2, textLength: b.textLength })),
      viewport: { width: 1200, height: 900, devicePixelRatio: 2 },
    };
    expect(cells(real(devicePx))).toBe(cells(real(css)));
    expect(cells(noDprSigner()(devicePx))).not.toBe(cells(noDprSigner()(css)));
    // Corpus-wide: 100% -> 86.7%. It does not fall to zero, and the reason is the next test.
    expect(scoreDprExact(real)).toBe(100);
    expect(scoreDprExact(noDprSigner())).toBeLessThan(100);
  });

  it('DPR half goes BLIND on a corpus without the `card` archetype — the probe would report green while perturbing nothing', () => {
    // `synth.ts:154-156` states this and it is true as measured: only the `card` archetype leaves a
    // page shorter AND narrower than the viewport, and only then does the viewport floor of the extent
    // normalisation bind. On every other shape the extent normalisation divides the DPR factor out on
    // its own, so a build with NO DPR handling at all scores a perfect 100%.
    //
    // This is the single most important assertion in the file: it pins the probe's own precondition.
    // If a future change drops the `card` archetype from the corpus, THIS test reds and says why,
    // instead of the DPR probe silently becoming a test that cannot fail.
    const cardFree = buildCorpus(30).filter((_, i) => i % 7 !== 6);
    expect(cardFree).toHaveLength(26);
    expect(scoreDprExact(real, cardFree)).toBe(100);
    expect(scoreDprExact(noDprSigner(), cardFree)).toBe(100); // <- a mutant scoring a PERFECT gate
    // ...and with the card pages present, the same mutant is caught.
    expect(scoreDprExact(noDprSigner())).toBeLessThan(100);
  });

  it('DPR half does NOT red the cross-viewport clause the spec assigns it — the two normalisations answer to different gates', () => {
    // Both renders in a cross-viewport comparison are captured at DPR 1, so removing the DPR division
    // cannot move that number by construction. The spec's probe line names one gate for two mutations;
    // this records that only the viewport half actually answers to it, so nobody later reads a green
    // cross-viewport number as evidence the DPR normalisation is present.
    expect(scoreCrossViewport(noDprSigner(), PROBE_WIDTH).inBandPct)
      .toBe(scoreCrossViewport(real, PROBE_WIDTH).inBandPct);
    expect(scoreSeparation(noDprSigner()).separatedPct).toBe(scoreSeparation(real).separatedPct);
  });

  it('viewport half: the cross-viewport clause goes from a pass to a fail at the width where it was green', () => {
    const before = scoreCrossViewport(real, PROBE_WIDTH);
    const after = scoreCrossViewport(noWidthNormSigner(), PROBE_WIDTH);
    expect(before.inBandPct).toBeGreaterThanOrEqual(CROSS_VIEWPORT_BAR);
    expect(after.inBandPct).toBeLessThan(CROSS_VIEWPORT_BAR);
    // And the damage grows with the width change rather than appearing only at the probe width, which
    // is what distinguishes a real inversion from a threshold that happened to land the right side.
    for (const width of [1024, 720]) {
      expect(scoreCrossViewport(noWidthNormSigner(), width).inBandPct).toBe(0);
      expect(scoreCrossViewport(real, width).inBandPct).toBeGreaterThan(0);
    }
  });

  it('viewport half is SURGICAL: clause 1 is untouched, so the red above is the cross-viewport clause and not collateral damage', () => {
    // At the desktop width the mutant and the real signer are the same function, so a clause-1 number
    // that moved would mean the mutation reached something it was not supposed to.
    expect(scoreSeparation(noWidthNormSigner()).separatedPct).toBe(scoreSeparation(real).separatedPct);
    expect(scoreDprExact(noWidthNormSigner())).toBe(100);
  });
});

/* ------------------------------------------------------------------ *
 * PROBE 3 — "replace the one-shot harvest with the per-node loop (G-S11a-2 must red)"
 * ------------------------------------------------------------------ */

/** ~900 interactive elements: the page size `snapshot.ts:10-12` measured the perception layer against. */
const PAGE_NODES = 900;
const pageBounds = Array.from({ length: PAGE_NODES }, (_, i) =>
  [(i * 37) % 1100, (i * 53) % 4800, 60 + (i % 40), 20 + (i % 12)]);

function countingCdp(calls: string[]): LayoutCdp {
  return {
    async send(method, params) {
      calls.push(method);
      if (method === 'DOMSnapshot.captureSnapshot') {
        return {
          strings: [''],
          documents: [{
            contentWidth: 1200, contentHeight: 4900,
            layout: { bounds: pageBounds, text: pageBounds.map(() => -1) },
          }],
        };
      }
      const b = pageBounds[Number(params?.nodeId ?? 0)];
      return { model: { width: b[2], height: b[3], content: [b[0], b[1], b[0] + b[2], b[1], b[0] + b[2], b[1] + b[3], b[0], b[1] + b[3]] } };
    },
  };
}

/** D4's refused harvest: one `DOM.getBoxModel` per node, awaited serially — `boxForNode`'s shape. */
async function perNodeHarvest(cdp: LayoutCdp, nodes: number): Promise<LayoutInput> {
  const boxes: LayoutBox[] = [];
  for (let nodeId = 0; nodeId < nodes; nodeId++) {
    const r = (await cdp.send('DOM.getBoxModel', { nodeId })) as { model?: { content?: number[]; width?: number; height?: number } };
    const c = r?.model?.content;
    if (!c || c.length < 8 || typeof r.model?.width !== 'number' || typeof r.model?.height !== 'number') continue;
    boxes.push({ x: c[0], y: c[1], width: r.model.width, height: r.model.height, textLength: 0 });
  }
  return { boxes, viewport: { width: 1200, height: 4900, devicePixelRatio: 1 } };
}

describe('PROBE 3 — the per-node loop must red G-S11a-2 (<= 1 CDP round trip per page)', () => {
  it('the SAME counting transport reports 1 for the shipped harvest and one-per-node for the refused one', async () => {
    // The point is not that 900 > 1. It is that the counter G-S11a-2 is asserted on is a LIVE
    // detector: on the shipped harvest it reads 1, and when the harvest is replaced by the shape D4
    // refuses, the same counter reads 900. A budget asserted on an instrument that always reads 1
    // would be a test that cannot fail, which is the failure mode this probe exists to rule out.
    const oneShot: string[] = [];
    const r = await harvestLayout(countingCdp(oneShot));
    expect(r.ok).toBe(true);
    expect(oneShot).toHaveLength(1);
    expect(oneShot[0]).toBe('DOMSnapshot.captureSnapshot');

    const perNode: string[] = [];
    await perNodeHarvest(countingCdp(perNode), PAGE_NODES);
    expect(perNode).toHaveLength(PAGE_NODES);
    expect(perNode.every((m) => m === 'DOM.getBoxModel')).toBe(true);
    expect(perNode.length).toBeGreaterThan(1); // the literal budget assertion, now failing
  });

  it('the refused harvest produces an EQUIVALENT signature — the round-trip budget is the only axis it fails on', async () => {
    // Stated because it is the whole reason G-S11a-2 has to be a budget and not a correctness test:
    // a per-node loop is not wrong, it is unaffordable. If it also produced a different vector, the
    // budget would be redundant with the separation gate and D4 would not need to exist.
    const a = await harvestLayout(countingCdp([]));
    if (!a.ok) throw new Error('expected ok');
    const b = await perNodeHarvest(countingCdp([]), PAGE_NODES);
    expect(serializeLayoutSignature(computeLayoutSignature(b)))
      .toBe(serializeLayoutSignature(computeLayoutSignature(a.input)));
  });
});

/* ------------------------------------------------------------------ *
 * PROBE 4 — "remove the D5 clamp and feed a hostile 10^9-px box (the clamp test must red)"
 * ------------------------------------------------------------------ */

const K = UNCLAMP_SCALE;
const unclamped = (input: LayoutInput): LayoutSignature => unclampedSignature(input, K);

const HOSTILE = 1e9;
const hostileOnly: LayoutInput = { boxes: [box(0, 0, HOSTILE, HOSTILE, 10)], viewport: VP };
const clampEquivalent: LayoutInput = {
  boxes: [box(0, 0, MAX_LAYOUT_COORD_PX, MAX_LAYOUT_COORD_PX, 10)], viewport: VP,
};

describe('PROBE 4 — removing the D5 clamp must red the clamp test', () => {
  it('the no-clamp surrogate is exact inside its validity window, and provably wrong outside it', () => {
    // Inside the window (scaled extent 1200/1024 = 1.17 > 1) a uniform power-of-two scale is a no-op
    // on the shipped signer, which is what makes it a faithful stand-in for a removed clamp.
    const p = threeColumn();
    expect(serializeLayoutSignature(computeLayoutSignature(scaleInput(p, 2 ** 10))))
      .toBe(serializeLayoutSignature(computeLayoutSignature(p)));
    // Outside it (scaled extent 0.0011 < 1) the 1-px extent floor takes over and the surrogate no
    // longer models anything. Asserted so the window is a checked precondition, not a comment.
    expect(serializeLayoutSignature(computeLayoutSignature(scaleInput(p, 2 ** 20))))
      .not.toBe(serializeLayoutSignature(computeLayoutSignature(p)));
    // ...and the hostile input used below IS inside the window: 1e9/2^20 = 953, over the floor and
    // under the clamp. The corpus, by contrast, is NOT — which is why no probe here signs a corpus
    // page through this surrogate.
    expect(unclampWindowHolds(HOSTILE, HOSTILE, K)).toBe(true);
    expect(unclampWindowHolds(DESKTOP_WIDTH, DESKTOP_WIDTH, K)).toBe(false);
  });

  it('reds the clamp test: a hostile 10^9-px box is reported as clamped by the real build and NOT by the no-clamp one', () => {
    expect(computeLayoutSignature(hostileOnly).clamped).toBe(true);
    expect(unclamped(hostileOnly).clamped).toBe(false);
    // Both other hostile shapes the D5 suite covers behave the same way.
    const origin: LayoutInput = { boxes: [box(1e12, 1e12, 100, 100, 10), box(100, 100, 200, 50, 30)], viewport: VP };
    expect(computeLayoutSignature(origin).clamped).toBe(true);
    expect(computeLayoutSignature(scaleInput(origin, 2 ** 25)).clamped).toBe(false);
  });

  it('and reveals the clamp test is thinner than it reads: only the `clamped` flag detects the removal', () => {
    // `signature.test.ts:253` makes three assertions. Under a no-clamp build, measured live, exactly
    // one of them reds. The cells assertion cannot red because BOTH builds reduce a single page-filling
    // box to the same normalised vector — the comparison is scale-invariant, which is the property the
    // clamp does not affect. Recorded so nobody reads "the clamp test" as broader coverage than the
    // one flag it actually rests on.
    const equiv = computeLayoutSignature(clampEquivalent);
    const mutant = unclamped(hostileOnly);
    expect(mutant.boxCount).toBe(equiv.boxCount);      // passes on the mutant
    expect(cells(mutant)).toBe(cells(equiv));          // passes on the mutant
    expect(mutant.clamped).toBe(false);                // the ONLY thing that reds
  });

  it('G-S11a-1 is blind to the clamp entirely — the corpus carries no hostile geometry, so only the unit assertions can catch it', () => {
    // A second mechanism keyed on a predicate that never fires is not a second layer of defence. The
    // separation gate and the D5 clamp are often read together as "hostile input is covered"; they are
    // not, and the reason is structural rather than statistical: `clampCoord` is the IDENTITY on every
    // box the corpus produces, so removing it cannot change a single corpus number. Confirmed by a
    // live `clampCoord = identity` mutation, which left clause 1, clause 2 and DPR-exactness bit-identical.
    for (const width of [DESKTOP_WIDTH, PROBE_WIDTH, 720]) {
      for (const p of buildCorpus(30)) {
        const input = layoutPage(p, width, { slotHeight: 90 });
        for (const b of input.boxes) {
          expect(Math.abs(b.x)).toBeLessThan(MAX_LAYOUT_COORD_PX);
          expect(Math.abs(b.y)).toBeLessThan(MAX_LAYOUT_COORD_PX);
          expect(b.width).toBeLessThan(MAX_LAYOUT_COORD_PX);
          expect(b.height).toBeLessThan(MAX_LAYOUT_COORD_PX);
        }
        expect(real(input).clamped).toBe(false);
      }
    }
  });

  it('the flag is the ONLY signal a hostile page leaves, because the clamp does not save the signature — so it must be set on every hostile path', () => {
    // Measured on the SHIPPED build: injecting one 10^9-px box moves a page 0.56 from itself, against
    // a same-page band near 0.02. The clamp bounds the arithmetic; it does not preserve the vector.
    // A consumer therefore cannot rely on the geometry surviving, only on being TOLD it was touched —
    // which is what makes `clamped` load-bearing rather than diagnostic.
    const clean = computeLayoutSignature(threeColumn());
    const poisoned = computeLayoutSignature({ boxes: [...threeColumn().boxes, box(0, 0, HOSTILE, HOSTILE, 0)], viewport: VP });
    expect(poisoned.clamped).toBe(true);
    expect(layoutDistance(clean, poisoned)).toBeGreaterThan(0.5);
    // The same box injected into a STRUCTURALLY UNRELATED page drives the two together rather than
    // apart, so the flag is the only thing separating "this page was measured" from "this page chose
    // its own signature". Bounded, not asserted as a fixed value: this is a known limitation being
    // recorded, not a behaviour being pinned in place.
    const docsPoisoned = computeLayoutSignature({ boxes: [...docsPage().boxes, box(0, 0, HOSTILE, HOSTILE, 0)], viewport: VP });
    expect(docsPoisoned.clamped).toBe(true);
    expect(layoutDistance(poisoned, docsPoisoned)).toBeLessThan(layoutDistance(clean, computeLayoutSignature(docsPage())));
  });
});
