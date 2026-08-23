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
 * Every corpus here is BUILT IN THE TEST, so these assertions do not depend on the network, on the
 * frozen capture, or on which pages happened to load on the day.
 */
import { describe, it, expect } from 'vitest';
import type { LayoutInput } from '../../src/studio/layout/signature.js';
import {
  MIN_CORPUS_PAGES,
  MIN_FLOOR_BINDING_PAGES,
  completePages,
  dprClauseJudgeable,
  floorBinds,
  measureAdequacy,
  type CapturedPage,
  type FrozenCorpus,
} from '../../benchmarks/visual/corpus.js';
import { layoutPage, buildCorpus } from '../../benchmarks/visual/synth.js';
import { realSeparation } from '../../benchmarks/visual/score-real.js';
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
