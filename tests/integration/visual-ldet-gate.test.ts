/**
 * The L-DET corpus gate — the assertions that must be able to RED in CI.
 *
 * `benchmarks/visual/gate.ts` prints numbers; a printed number cannot fail a build. What has to be
 * enforceable is the thing the old harness got wrong: **a corpus that cannot judge a clause must say
 * so rather than report a pass.** `benchmarks/visual/score.ts:122-131` recorded the defect and
 * `tests/unit/studio/layout/inversion-probes.test.ts:178-192` pinned it as a live expectation — a
 * mutant scoring a PERFECT gate on a corpus with one archetype removed. Those assertions stay; this
 * file adds the check that stops that state being reported as a pass.
 *
 * Two kinds of assertion live here and the difference matters. The composition checks build their
 * corpus IN THE TEST, so they depend on no capture and no network — they are about the gate's own
 * logic. The G-S11a block scores the FROZEN corpus, because the spec's §5 dependency table makes
 * S11b/c/d conditional on the gate having passed, and a verdict that was true once on the day it was
 * measured is not that. Freezing the corpus is what lets the verdict be re-checked instead of
 * re-captured against a web that has moved on.
 */
import { describe, it, expect } from 'vitest';
import {
  MAX_SIGNATURE_BYTES,
  computeLayoutSignature,
  serializeLayoutSignature,
  type LayoutInput,
} from '../../src/studio/layout/signature.js';
import {
  MIN_CORPUS_PAGES,
  MIN_FLOOR_BINDING_PAGES,
  completePages,
  dprClauseJudgeable,
  floorBinds,
  loadCorpus,
  measureAdequacy,
  renderOf,
  type CapturedPage,
  type FrozenCorpus,
} from '../../benchmarks/visual/corpus.js';
import { layoutPage, buildCorpus } from '../../benchmarks/visual/synth.js';
import { attributeDpr2, realCrossViewport, realSeparation } from '../../benchmarks/visual/score-real.js';
import { noWidthNormSigner } from '../../benchmarks/visual/mutants.js';
import { GATE_ALT_WIDTH } from '../../benchmarks/visual/gate-config.js';
import { scoreSeparation, signerAt, DESKTOP_WIDTH } from '../../benchmarks/visual/score.js';
import { mulberry32 } from '../../benchmarks/visual/synth.js';

const ALT_WIDTHS = [1152, 1024];

function page(url: string, group: string, renders: Array<[string, number, number, LayoutInput]>): CapturedPage {
  return {
    url,
    group,
    renders: renders.map(([kind, viewportWidth, deviceScaleFactor, input]) => ({
      kind: kind as CapturedPage['renders'][number]['kind'],
      viewportWidth,
      deviceScaleFactor,
      input,
      sends: 1,
      harvestMs: 1,
    })),
  };
}

/** A page whose content reaches the viewport edge on both axes — the floor does NOT bind. */
function fullBleed(width: number, dpr = 1): LayoutInput {
  return {
    boxes: [
      { x: 0, y: 0, width, height: 400, textLength: 100 },
      { x: 0, y: 400, width, height: 1200, textLength: 900 },
    ],
    viewport: { width, height: 900, devicePixelRatio: dpr },
  };
}

/** A centred card, shorter AND narrower than the viewport — the floor binds on both axes. */
function card(width: number, dpr = 1): LayoutInput {
  const w = 360;
  const x = Math.max(0, Math.floor((width - w) / 2));
  return {
    boxes: [
      { x, y: 40, width: w, height: 120, textLength: 30 },
      { x, y: 180, width: w, height: 120, textLength: 30 },
    ],
    viewport: { width, height: 900, devicePixelRatio: dpr },
  };
}

function corpusOf(pages: CapturedPage[]): FrozenCorpus {
  return {
    version: 1,
    provenance: {
      capturedAt: '2026-08-23T00:00:00.000Z',
      browserEngine: 'chromium',
      browserVersion: 'test',
      platform: 'test',
      refWidth: 1280,
      altWidth: 1024,
      altWidthSweep: ALT_WIDTHS,
      viewportHeight: 900,
      attempted: pages.length,
      failures: [],
    },
    pages,
  };
}

/** n pages of one shape, each carrying every render the gate scores. */
function pagesOf(n: number, shape: (w: number, dpr: number) => LayoutInput, group: string, dpr2 = 2): CapturedPage[] {
  return Array.from({ length: n }, (_, i) =>
    page(`https://example.test/${group}-${i}`, group, [
      ['ref_a', 1280, 1, shape(1280, 1)],
      ['ref_b', 1280, 1, shape(1280, 1)],
      ...ALT_WIDTHS.map((w): [string, number, number, LayoutInput] => ['alt_width', w, 1, shape(w, 1)]),
      ['dpr2', 1280, 2, shape(1280, dpr2)],
    ]),
  );
}

describe('floorBinds — the predicate the device-ratio clause hangs on', () => {
  it('binds when the content is strictly inside the viewport on an axis, which is the only case a uniform scaling survives', () => {
    expect(floorBinds(card(1280))).toEqual({ x: true, y: true });
  });

  it('does NOT bind at the boundary: content reaching exactly the viewport edge makes the extent the content, not the floor', () => {
    // `signature.ts:232` is `max(viewport, contentEdge, 1)`. At equality the extent is the content
    // edge and scales with it, so the ratio divides straight back out — the boundary belongs to the
    // NON-binding side, and a predicate that used `>=` would claim judgeability it does not have.
    expect(floorBinds(fullBleed(1280))).toEqual({ x: false, y: false });
  });

  it('reports the axes independently, because a page can bind on one and not the other', () => {
    const wideButShort: LayoutInput = {
      boxes: [{ x: 0, y: 0, width: 1280, height: 100, textLength: 10 }],
      viewport: { width: 1280, height: 900, devicePixelRatio: 1 },
    };
    expect(floorBinds(wideButShort)).toEqual({ x: false, y: true });
  });
});

describe('the DPR clause refuses a corpus that cannot judge it — the defect `score.ts:122-131` records', () => {
  it('MUST NOT FIRE on an adequate corpus: floor-binding pages present and a ratio other than 1 reported', () => {
    const c = corpusOf([...pagesOf(20, fullBleed, 'landing'), ...pagesOf(MIN_FLOOR_BINDING_PAGES, card, 'floor-binding')]);
    const verdict = dprClauseJudgeable(measureAdequacy(c));
    expect(verdict.judgeable).toBe(true);
  });

  it('FIRES when the floor-binding archetype is removed — the exact composition that reported a perfect score for a build with no ratio handling', () => {
    const c = corpusOf(pagesOf(30, fullBleed, 'landing'));
    const verdict = dprClauseJudgeable(measureAdequacy(c));
    expect(verdict.judgeable).toBe(false);
    expect(verdict.reason).toContain('floor');
  });

  it('FIRES when no render reports a ratio other than 1 — the shipped harvest\'s own shape, where the division is the identity', () => {
    // Not a hypothetical: `src/studio/layout/harvest.ts:131-135` hard-codes a ratio of 1 for every
    // page it ever returns, so this is the composition every real capture through the product has.
    const c = corpusOf([...pagesOf(20, fullBleed, 'landing', 1), ...pagesOf(10, card, 'floor-binding', 1)]);
    const verdict = dprClauseJudgeable(measureAdequacy(c));
    expect(verdict.judgeable).toBe(false);
    expect(verdict.reason).toContain('device pixel ratio other than 1');
  });

  it('OVER-FIRE PROBE: it keys on the two stated preconditions and on nothing else', () => {
    // A gate that also happened to key on corpus size, group labels or box counts would refuse
    // corpora it has no business refusing, and its passes would stop meaning what they say.
    const base = [...pagesOf(20, fullBleed, 'landing'), ...pagesOf(MIN_FLOOR_BINDING_PAGES, card, 'floor-binding')];
    expect(dprClauseJudgeable(measureAdequacy(corpusOf(base))).judgeable).toBe(true);

    // Twelve times the pages, same composition.
    const huge = Array.from({ length: 12 }, () => base).flat().map((p, i) => ({ ...p, url: `${p.url}#${i}` }));
    expect(dprClauseJudgeable(measureAdequacy(corpusOf(huge))).judgeable).toBe(true);

    // Below the L-DET page minimum, but the composition is still adequate: judgeability and corpus
    // size are different questions and the gate must not conflate them.
    const tiny = [...pagesOf(2, fullBleed, 'landing'), ...pagesOf(MIN_FLOOR_BINDING_PAGES, card, 'floor-binding')];
    expect(corpusOf(tiny).pages.length).toBeLessThan(MIN_CORPUS_PAGES);
    expect(dprClauseJudgeable(measureAdequacy(corpusOf(tiny))).judgeable).toBe(true);

    // Group LABELS are seed metadata; the measurement is taken from the geometry, so mislabelling
    // every page must not change the verdict either way.
    const mislabelled = base.map((p) => ({ ...p, group: 'landing' }));
    expect(dprClauseJudgeable(measureAdequacy(corpusOf(mislabelled))).judgeable).toBe(true);
  });

  it('needs more than ONE floor-binding page, so a single capture failure cannot silently return the corpus to the blind state', () => {
    const oneOnly = [...pagesOf(29, fullBleed, 'landing'), ...pagesOf(1, card, 'floor-binding')];
    expect(dprClauseJudgeable(measureAdequacy(corpusOf(oneOnly))).judgeable).toBe(false);
    const enough = [...pagesOf(29, fullBleed, 'landing'), ...pagesOf(MIN_FLOOR_BINDING_PAGES, card, 'floor-binding')];
    expect(dprClauseJudgeable(measureAdequacy(corpusOf(enough))).judgeable).toBe(true);
  });
});

describe('completePages — a clause is never scored over a different subset than its neighbour', () => {
  it('drops a page missing any render the gate scores, rather than scoring it on the clauses it can still answer', () => {
    const full = pagesOf(3, fullBleed, 'landing');
    const partial = page('https://example.test/partial', 'landing', [
      ['ref_a', 1280, 1, fullBleed(1280)],
      ['ref_b', 1280, 1, fullBleed(1280)],
    ]);
    const c = corpusOf([...full, partial]);
    expect(c.pages).toHaveLength(4);
    expect(completePages(c)).toHaveLength(3);
  });

  it('drops a page missing ONE width of the sweep — a per-width verdict taken over a different page set is not comparable across widths', () => {
    const missingOneWidth = page('https://example.test/one-width', 'landing', [
      ['ref_a', 1280, 1, fullBleed(1280)],
      ['ref_b', 1280, 1, fullBleed(1280)],
      ['alt_width', 1152, 1, fullBleed(1152)],
      ['dpr2', 1280, 2, fullBleed(1280, 2)],
    ]);
    expect(completePages(corpusOf([missingOneWidth]))).toHaveLength(0);
  });
});

describe('G-S11a on the FROZEN corpus — the measured verdict, as an assertion that can red', () => {
  // `gate.ts` PRINTS these numbers and a printed number cannot fail a build. The spec's §5
  // dependency table makes S11b/c/d conditional on "G-S11a-1/2/3 all passed and recorded", so the
  // verdict has to keep holding rather than have held once on the day it was measured. These
  // assertions are what turns it into a standing gate: change the quantiser and they red.
  const corpus = loadCorpus();
  const pages = completePages(corpus);

  it('is scored on a corpus L-DET permits a verdict from: real pages, at or above the mandated size', () => {
    expect(pages.length).toBeGreaterThanOrEqual(MIN_CORPUS_PAGES);
    // Real pages, not generated ones — the property `synth.ts:14-18` says the synthetic runner lacks.
    expect(pages.every((p) => p.url.startsWith('http'))).toBe(true);
    expect(corpus.provenance.browserEngine).toBe('chromium');
  });

  it('G-S11a-1 clause 1: two renders of one page separate from different pages on >= 95% of the corpus', () => {
    const s = realSeparation(corpus, signerAt());
    expect(s.pages).toBe(pages.length);
    expect(s.separatedPct).toBeGreaterThanOrEqual(95);
  });

  it('G-S11a-1 clause 2: >= 90% stay in the same-page band across the width change, AT THE PINNED WIDTH', () => {
    expect(corpus.provenance.altWidthSweep).toContain(GATE_ALT_WIDTH);
    expect(realCrossViewport(corpus, signerAt(), GATE_ALT_WIDTH).inBandPct).toBeGreaterThanOrEqual(90);
  });

  it('and the pinned width is one where the clause HAS POWER: the normalisation mutant reds where the shipped signer passes', () => {
    // Without this, a green clause 2 is compatible with the viewport normalisation having been
    // deleted — at 1152 both signers clear the threshold. The pin is only meaningful if the mutant
    // the spec mandates (`:475-478`, "skip the DPR/viewport normalisation") actually fails here.
    expect(realCrossViewport(corpus, noWidthNormSigner(), GATE_ALT_WIDTH).inBandPct).toBeLessThan(90);
  });

  it('G-S11a-2: every capture cost exactly one round trip, counted on the injected transport at capture time', () => {
    const sends = new Set(pages.flatMap((p) => p.renders.map((r) => r.sends)));
    expect([...sends]).toEqual([1]);
  });

  it('G-S11a-3: the serialised signature stays inside 2 KB on the heaviest real page in the corpus', () => {
    const largest = Math.max(
      ...pages.map((p) => {
        const r = renderOf(p, 'ref_a');
        return r ? Buffer.byteLength(serializeLayoutSignature(computeLayoutSignature(r)), 'utf8') : 0;
      }),
    );
    expect(largest).toBeGreaterThan(0);
    expect(largest).toBeLessThanOrEqual(MAX_SIGNATURE_BYTES);
  });

  it('the device-ratio arm introduced no error of its own: every signature that moved had a capture that moved first', () => {
    // This is the assertion the bare exactness percentage cannot make. 76% exact reads like a
    // failure and is not one: real pages genuinely re-layout at a scale factor of 2 (responsive
    // image selection changes intrinsic sizes). What would be a defect is an IDENTICAL capture
    // signing differently, and that count must be zero.
    const attr = attributeDpr2(corpus, signerAt());
    expect(attr.metricIntroduced).toBe(0);
  });
});

describe('the corpus-size refusal — a shrunken corpus is a weaker gate wearing the same output', () => {
  it('FIRES below the L-DET minimum, counting COMPLETE pages rather than captured ones', () => {
    // The distinction is the whole point: 30 pages of which 8 lost a render is not a 30-page corpus,
    // and a count taken before the completeness filter would report one.
    const nearlyEnough = pagesOf(MIN_CORPUS_PAGES, fullBleed, 'landing');
    const oneBroken = nearlyEnough.map((p, i) =>
      i === 0 ? { ...p, renders: p.renders.filter((r) => r.kind !== 'dpr2') } : p,
    );
    expect(oneBroken).toHaveLength(MIN_CORPUS_PAGES);
    expect(completePages(corpusOf(oneBroken)).length).toBeLessThan(MIN_CORPUS_PAGES);
  });

  it('MUST NOT FIRE at exactly the minimum — the spec says ">= 30", and an off-by-one here silently raises the bar', () => {
    expect(completePages(corpusOf(pagesOf(MIN_CORPUS_PAGES, fullBleed, 'landing'))).length).toBe(MIN_CORPUS_PAGES);
  });
});

describe('the real-corpus scorer is the SAME arithmetic as the synthetic one', () => {
  it('reproduces `scoreSeparation` exactly when handed the same renders — the probes and the gate cannot be measuring different metrics', () => {
    // Two copies of one scoring rule drift, and the drift is invisible: both keep printing numbers.
    // So the equivalence is asserted rather than commented. The synthetic scorer generates its
    // second render from a seeded PRNG; reproducing that sequence here is what makes the two inputs
    // the same renders rather than merely similar ones.
    const descs = buildCorpus(30);
    const rnd = mulberry32(0xc0ffee);
    const captured: CapturedPage[] = descs.map((d, i) => {
      const a = layoutPage(d, DESKTOP_WIDTH, { slotHeight: 90 });
      const b = layoutPage(d, DESKTOP_WIDTH, {
        drift: 0.4 + rnd() * 0.4,
        textChurn: 0.97 + rnd() * 0.06,
        slotHeight: 90 + Math.round(rnd() * 40),
      });
      return page(`https://synth.test/${i}`, 'synthetic', [
        ['ref_a', DESKTOP_WIDTH, 1, a],
        ['ref_b', DESKTOP_WIDTH, 1, b],
        ...ALT_WIDTHS.map((w): [string, number, number, LayoutInput] => ['alt_width', w, 1, layoutPage(d, w, { slotHeight: 90 })]),
        ['dpr2', DESKTOP_WIDTH, 1, layoutPage(d, DESKTOP_WIDTH, { slotHeight: 90, devicePixelRatio: 2 })],
      ]);
    });

    const viaReal = realSeparation(corpusOf(captured), signerAt());
    const viaSynth = scoreSeparation(signerAt());

    expect(viaReal.pages).toBe(30);
    expect(viaReal.pairs).toBe(viaSynth.pairs);
    expect(viaReal.crossP5).toBe(viaSynth.crossP5);
    expect(viaReal.samePageP50).toBe(viaSynth.samePageP50);
    expect(viaReal.separatedPct).toBe(viaSynth.separatedPct);
  });
});
