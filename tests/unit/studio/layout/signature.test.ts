import { describe, it, expect } from 'vitest';
import {
  computeLayoutSignature,
  layoutDistance,
  serializeLayoutSignature,
  LAYOUT_GRID_X,
  LAYOUT_GRID_Y,
  LAYOUT_CHANNELS,
  MAX_LAYOUT_COORD_PX,
  type LayoutBox,
  type LayoutInput,
} from '../../../../src/studio/layout/signature.js';

const VP = { width: 1200, height: 900, devicePixelRatio: 1 };

const box = (x: number, y: number, width: number, height: number, textLength = 0): LayoutBox => ({
  x, y, width, height, textLength,
});

/** A three-column card grid over a header + footer — the archetype D3 names. */
function threeColumn(): LayoutInput {
  const boxes: LayoutBox[] = [box(0, 0, 1200, 80, 40)];
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 3; col++) {
      boxes.push(box(20 + col * 400, 100 + row * 220, 360, 200, 180));
    }
  }
  boxes.push(box(0, 1000, 1200, 120, 60));
  return { boxes, viewport: VP };
}

/** The SAME content reflowed to one column — every box moves, the document triples in height. */
function oneColumn(): LayoutInput {
  const boxes: LayoutBox[] = [box(0, 0, 1200, 80, 40)];
  for (let i = 0; i < 12; i++) boxes.push(box(20, 100 + i * 220, 1160, 200, 180));
  boxes.push(box(0, 2760, 1200, 120, 60));
  return { boxes, viewport: VP };
}

/**
 * A centred login card: the whole page is SMALLER than the viewport in both axes. This is the only
 * shape in which the viewport floor of the extent normalisation actually binds, which is what makes
 * it the only shape that can test DPR handling — see the DPR case for why.
 */
function loginCard(): LayoutInput {
  return {
    boxes: [
      box(450, 300, 300, 240, 0),
      box(470, 320, 260, 40, 12),
      box(470, 380, 260, 36, 8),
      box(470, 430, 260, 36, 8),
      box(470, 480, 260, 40, 6),
    ],
    viewport: VP,
  };
}

/** A challenge interstitial: a handful of small centred boxes, nothing else. */
function interstitial(): LayoutInput {
  return {
    boxes: [box(450, 380, 300, 60, 30), box(500, 460, 200, 40, 12), box(520, 520, 160, 32, 8)],
    viewport: VP,
  };
}

/** The three-column page with its sidebar region removed. */
function threeColumnNoSidebar(): LayoutInput {
  const src = threeColumn();
  return { ...src, boxes: src.boxes.filter((b) => b.x < 800) };
}

/** A structurally unrelated page: a dense left-rail docs layout. */
function docsPage(): LayoutInput {
  const boxes: LayoutBox[] = [];
  for (let i = 0; i < 30; i++) boxes.push(box(0, i * 30, 240, 26, 22));
  for (let i = 0; i < 8; i++) boxes.push(box(280, 40 + i * 110, 880, 96, 420));
  return { boxes, viewport: VP };
}

/** Re-render jitter: sub-pixel layout drift + a headline whose length changed slightly. */
function jitter(input: LayoutInput, factor = 1.02): LayoutInput {
  return {
    ...input,
    boxes: input.boxes.map((b) => ({
      x: b.x + 0.4, y: b.y + 0.6, width: b.width, height: b.height,
      textLength: Math.round((b.textLength ?? 0) * factor),
    })),
  };
}

const dist = (a: LayoutInput, b: LayoutInput) =>
  layoutDistance(computeLayoutSignature(a), computeLayoutSignature(b));

describe('LayoutSignature — INVARIANT TO (a signature that moves with content is useless for heal/look-alike)', () => {
  it('is invariant to device pixel ratio: the same render reported in device px at DPR 2 signs identically to CSS px at DPR 1', () => {
    // The page must be SHORTER AND NARROWER than the viewport, or this test cannot see the bug it
    // guards: when the content extent exceeds the viewport, the extent normalisation divides the
    // DPR factor out on its own and a build that ignored DPR entirely would still pass. Only when
    // the viewport floor binds does an un-divided device-px box change which of the two wins.
    const cssPx = loginCard();
    const devicePx: LayoutInput = {
      boxes: cssPx.boxes.map((b) => ({ x: b.x * 2, y: b.y * 2, width: b.width * 2, height: b.height * 2, textLength: b.textLength })),
      viewport: { width: 1200, height: 900, devicePixelRatio: 2 },
    };
    expect(serializeLayoutSignature(computeLayoutSignature(devicePx)))
      .toBe(serializeLayoutSignature(computeLayoutSignature(cssPx)));
  });

  it('is invariant to uniform scale: the same layout at a 3x larger viewport with 3x larger boxes signs identically', () => {
    const base = threeColumn();
    const scaled: LayoutInput = {
      boxes: base.boxes.map((b) => ({ x: b.x * 3, y: b.y * 3, width: b.width * 3, height: b.height * 3, textLength: b.textLength })),
      viewport: { width: 3600, height: 2700, devicePixelRatio: 1 },
    };
    expect(serializeLayoutSignature(computeLayoutSignature(scaled)))
      .toBe(serializeLayoutSignature(computeLayoutSignature(base)));
  });

  it('is invariant to small text churn: a headline edit plus sub-pixel drift stays deep inside the same-page band while a different page does not', () => {
    const a = threeColumn();
    const churn = dist(a, jitter(a));
    const different = dist(a, docsPage());
    // Two-sided on purpose: a signature that hashed content would blow the first bound, and a
    // signature that returned a constant would collapse the second.
    expect(churn).toBeLessThan(0.02);
    expect(different).toBeGreaterThan(0.2);
  });

  it('is invariant to total text volume: multiplying every text length by 10 leaves the signature unchanged (the profile is normalised, not absolute)', () => {
    const a = threeColumn();
    const b: LayoutInput = { ...a, boxes: a.boxes.map((x) => ({ ...x, textLength: (x.textLength ?? 0) * 10 })) };
    expect(serializeLayoutSignature(computeLayoutSignature(b)))
      .toBe(serializeLayoutSignature(computeLayoutSignature(a)));
  });

  it('is invariant to harvest order: the same boxes delivered reversed sign identically (the harvest order is a CDP implementation detail)', () => {
    const a = threeColumn();
    const b: LayoutInput = { ...a, boxes: [...a.boxes].reverse() };
    expect(serializeLayoutSignature(computeLayoutSignature(b)))
      .toBe(serializeLayoutSignature(computeLayoutSignature(a)));
  });
});

describe('LayoutSignature — DISCRIMINATES ON (a signature that never collides is as broken as one that always does)', () => {
  it('separates two structurally different pages by more than two renders of the same page', () => {
    const same = dist(threeColumn(), jitter(threeColumn(), 1.05));
    const different = dist(threeColumn(), docsPage());
    expect(same).toBeLessThan(different);
    expect(different - same).toBeGreaterThan(0.2);
  });

  it('separates a page from a challenge interstitial that replaced it — the case D3 names as the one geometry MUST catch', () => {
    const replaced = dist(threeColumn(), interstitial());
    expect(replaced).toBeGreaterThan(0.5);
  });

  it('moves when a major region is removed: dropping the right column exceeds the re-render jitter band', () => {
    const jitterBand = dist(threeColumn(), jitter(threeColumn(), 1.05));
    expect(dist(threeColumn(), threeColumnNoSidebar())).toBeGreaterThan(jitterBand);
  });

  it('a 3-column to 1-column reflow is DISCERNIBLE but lands nearer than a page REPLACEMENT (D3: the reflow preserves the density profile, the interstitial destroys it)', () => {
    const reflow = dist(threeColumn(), oneColumn());
    expect(reflow).toBeGreaterThan(0);
    expect(reflow).toBeLessThan(dist(threeColumn(), interstitial()));
  });

  it('layoutDistance is a bounded, symmetric metric with identity zero — the property every gate in S11 is scored against', () => {
    const a = computeLayoutSignature(threeColumn());
    const b = computeLayoutSignature(docsPage());
    expect(layoutDistance(a, a)).toBe(0);
    expect(layoutDistance(a, b)).toBeCloseTo(layoutDistance(b, a), 12);
    expect(layoutDistance(a, b)).toBeGreaterThanOrEqual(0);
    expect(layoutDistance(a, b)).toBeLessThanOrEqual(1);
  });
});

describe('LayoutSignature — element churn (the axis jitter() cannot reach: boxes APPEARING and DISAPPEARING)', () => {
  // `jitter()` perturbs the boxes a page already has and can never add or remove one, so it could
  // not see that a single sub-cell element used to move a page 0.412 from itself against 0.385 for
  // a completely unrelated page. A lazily-inserted icon is exactly the noise this must survive.
  const subCell: Array<[string, LayoutBox]> = [
    ['a 1x1 tracking pixel', box(1180, 1118, 1, 1, 0)],
    ['a favicon-sized icon', box(4, 4, 16, 16, 0)],
    ['a consent-banner close button', box(1150, 20, 24, 24, 1)],
  ];

  it.each(subCell)('adding %s cannot make the page look less like itself than an unrelated page does', (_label, extra) => {
    const base = threeColumn();
    const added = { ...base, boxes: [...base.boxes, extra] };
    const unrelated = dist(base, docsPage());
    expect(dist(base, added)).toBeLessThan(unrelated);
    expect(dist(base, added)).toBeLessThan(0.02); // and it must stay inside the same-page band, not merely beat the reference
  });

  it('REMOVING a sub-cell element is equally survivable — the axis runs in both directions', () => {
    const withIcon = { ...threeColumn(), boxes: [...threeColumn().boxes, box(4, 4, 16, 16, 0)] };
    expect(dist(withIcon, threeColumn())).toBeLessThan(0.02);
  });

  it('a page-sized wrapper cannot dominate the content inside it either — the cap is bounded at BOTH ends', () => {
    const wrapped = { ...threeColumn(), boxes: [box(0, 0, 1200, 1120, 0), ...threeColumn().boxes] };
    expect(dist(threeColumn(), wrapped)).toBeLessThan(0.1);
  });
});

describe('LayoutSignature — degenerate pages (a signature is required for every page, including the ones with no layout)', () => {
  it('an empty page signs to an all-zero vector of the fixed length, and two empty pages are distance 0 (not NaN)', () => {
    const sig = computeLayoutSignature({ boxes: [], viewport: VP });
    expect(sig.cells).toHaveLength(LAYOUT_GRID_X * LAYOUT_GRID_Y * LAYOUT_CHANNELS);
    expect(Array.from(sig.cells).every((c) => c === 0)).toBe(true);
    expect(sig.boxCount).toBe(0);
    expect(layoutDistance(sig, computeLayoutSignature({ boxes: [], viewport: VP }))).toBe(0);
  });

  it('an empty page is maximally distant from a rendered one — a blank render must never look like a match', () => {
    const empty = computeLayoutSignature({ boxes: [], viewport: VP });
    expect(layoutDistance(empty, computeLayoutSignature(threeColumn()))).toBe(1);
  });

  it('a blank render is distance 1 from a TEXT-FREE page too, not 0.5 — the harvest yields no text at all for a canvas or captcha page', () => {
    // The harvest reads text length from the layout tree's text index, which is absent for every
    // non-text node, so a canvas / image / captcha page has an entirely empty text channel. Folding
    // an empty-in-both channel in as distance 0 halved every such comparison.
    const textFreePage: LayoutInput = { ...threeColumn(), boxes: threeColumn().boxes.map((b) => ({ ...b, textLength: 0 })) };
    const blank = computeLayoutSignature({ boxes: [], viewport: VP });
    expect(layoutDistance(blank, computeLayoutSignature(textFreePage))).toBe(1);
  });

  it('two text-free pages use the FULL distance range — a threshold calibrated on text-bearing pages must not be off by 2x here', () => {
    const strip = (p: LayoutInput): LayoutInput => ({ ...p, boxes: p.boxes.map((b) => ({ ...b, textLength: 0 })) });
    expect(dist(strip(threeColumn()), strip(docsPage()))).toBeGreaterThan(0.5);
  });

  it('a single element still produces a well-formed normalised signature', () => {
    const sig = computeLayoutSignature({ boxes: [box(100, 100, 200, 50, 30)], viewport: VP });
    expect(sig.boxCount).toBe(1);
    expect(Array.from(sig.cells).some((c) => c > 0)).toBe(true);
    expect(Array.from(sig.cells).every((c) => Number.isInteger(c) && c >= 0 && c <= 255)).toBe(true);
  });
});

describe('LayoutSignature — D5: geometry is page-controlled, so it is clamped and welded untrusted', () => {
  it('a hostile MAX_VALUE-sized box cannot poison the normalisation: every cell stays finite and in range', () => {
    const sig = computeLayoutSignature({
      boxes: [box(0, 0, Number.MAX_VALUE, Number.MAX_VALUE, 100), box(100, 100, 200, 50, 30)],
      viewport: VP,
    });
    expect(Array.from(sig.cells).every((c) => Number.isFinite(c) && c >= 0 && c <= 255)).toBe(true);
    expect(sig.clamped).toBe(true);
  });

  it('a hostile 10^9-px box is clamped to MAX_LAYOUT_COORD_PX rather than dividing the whole page by an absurd extent', () => {
    const hostile = computeLayoutSignature({ boxes: [box(0, 0, 1e9, 1e9, 10)], viewport: VP });
    const clampedEquivalent = computeLayoutSignature({
      boxes: [box(0, 0, MAX_LAYOUT_COORD_PX, MAX_LAYOUT_COORD_PX, 10)],
      viewport: VP,
    });
    expect(hostile.clamped).toBe(true);
    expect(hostile.boxCount).toBe(clampedEquivalent.boxCount);
    expect(Array.from(hostile.cells)).toEqual(Array.from(clampedEquivalent.cells));
  });

  it('an out-of-range ORIGIN is clamped and REPORTED — the width clamp alone leaves the x/y divisor unbounded', () => {
    // The width/height clamp and the coordinate clamp are separate code paths. A box at a sane
    // origin with an absurd width exercises only the first; this one exercises only the second, so
    // a build that dropped `clampCoord` cannot pass by accident.
    const sig = computeLayoutSignature({
      boxes: [box(1e12, 1e12, 100, 100, 10), box(100, 100, 200, 50, 30)],
      viewport: VP,
    });
    expect(sig.clamped).toBe(true);
    expect(sig.boxCount).toBe(2);
    expect(Array.from(sig.cells).every((c) => Number.isFinite(c) && c >= 0 && c <= 255)).toBe(true);
  });

  it('non-finite and non-positive geometry is DROPPED, never propagated into the vector', () => {
    const sig = computeLayoutSignature({
      boxes: [
        box(NaN, 0, 100, 100, 10),
        box(0, Infinity, 100, 100, 10),
        box(0, 0, 0, 100, 10),
        box(0, 0, 100, -5, 10),
        box(100, 100, 200, 50, 30),
      ],
      viewport: VP,
    });
    expect(sig.boxCount).toBe(1);
    expect(Array.from(sig.cells).every(Number.isFinite)).toBe(true);
  });

  it('a hostile device pixel ratio (0, negative, 10^9) cannot collapse the page to a point', () => {
    for (const devicePixelRatio of [0, -2, 1e9, NaN]) {
      const sig = computeLayoutSignature({ boxes: threeColumn().boxes, viewport: { ...VP, devicePixelRatio } });
      expect(Array.from(sig.cells).every((c) => Number.isFinite(c))).toBe(true);
      expect(Array.from(sig.cells).some((c) => c > 0)).toBe(true);
    }
  });

  it('trusted is welded false at construction — the signature crosses the agent surface already on the data side', () => {
    const sig = computeLayoutSignature(threeColumn());
    expect(sig.trusted).toBe(false);
  });
});

describe('LayoutSignature — determinism (G-S11a-1 is meaningless if the same input signs two ways)', () => {
  it('the same input signs byte-identically on repeat', () => {
    const a = threeColumn();
    expect(serializeLayoutSignature(computeLayoutSignature(a)))
      .toBe(serializeLayoutSignature(computeLayoutSignature(a)));
  });

  it('pins the whole normalise-quantise pipeline to a golden string, so any arithmetic change is visible in review', () => {
    const sig = computeLayoutSignature({
      boxes: [box(0, 0, 1200, 100, 50), box(0, 100, 600, 400, 300), box(600, 100, 600, 400, 300)],
      viewport: VP,
    });
    // eslint-disable-next-line max-len -- a pinned wire value is only a pin if it is the literal value
    expect(serializeLayoutSignature(sig)).toBe(
      'lsig1:12x16:3:0:YGBgYGBgYGBgYGBgVVVVVVVVVVVVVVVVMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwKioqKisqKyorKyorAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFhYWFhYWFhYWFhYWICAgICAgICAgICAgQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCOzs7Ozs7Ozs7Ozs7AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    );
  });
});
