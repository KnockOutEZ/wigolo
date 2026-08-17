/**
 * L-DET corpus generator — SYNTHETIC, and deliberately so.
 *
 * WHAT THIS IS AND IS NOT. The S11 spec's L-DET asks for >= 30 real pages captured twice on one
 * build, plus once at a second viewport width and once at DPR 2. Acquiring, vendoring and licensing
 * a third-party page corpus is a legal question that is explicitly not this slice's to answer, so
 * this file synthesises the corpus instead. That trade is stated rather than hidden:
 *
 *   - What it CAN measure: that the metric separates re-renders of one page from renders of
 *     different pages; that the DPR and reflow normalisation behave as designed; that the
 *     serialised size and the round-trip budget hold; and which grid resolution is the coarsest
 *     that still separates (spec 6.1). Those are properties of the ARITHMETIC, and synthetic input
 *     measures arithmetic exactly as well as real input does.
 *   - What it CANNOT measure: whether real pages are as separable as these. Real re-render noise
 *     (lazy images shifting the fold, A/B variants, consent banners, ad slots of varying height,
 *     fonts loading late) is modelled here from a guess about what those do, so a pass here is
 *     evidence the metric is not broken, NOT evidence that G-S11a-1 holds on the web. Do not record
 *     a number from this runner as G-S11a-1 having passed.
 *
 * Pages are described STRUCTURALLY and laid out by `layoutPage`, so "the same page at a narrower
 * viewport" is a genuine re-flow of the same description rather than a hand-perturbation of the
 * output — a hand-perturbation would let the corpus author decide the answer.
 */
import type { LayoutBox, LayoutInput } from '../../src/studio/layout/signature.js';

export type SectionKind = 'header' | 'hero' | 'grid' | 'article' | 'rail' | 'table' | 'footer' | 'card';

export interface Section {
  kind: SectionKind;
  /** Natural column count at a desktop width; the layout collapses it when the viewport cannot hold it. */
  columns: number;
  items: number;
  itemHeight: number;
  textPerItem: number;
}

export interface PageDesc {
  id: string;
  sections: Section[];
  /** Width of a left rail, when the page has one. */
  railWidth: number;
}

/** Below this, a grid column is unreadable and a real layout collapses to fewer columns. */
const MIN_COLUMN_PX = 280;
/** Below this total width, a left rail stacks above the content instead of sitting beside it. */
const RAIL_BREAKPOINT_PX = 720;
const GUTTER = 20;

export interface LayoutOptions {
  /** Sub-pixel drift applied to every box — the noise floor of two renders of one page. */
  drift?: number;
  /** Multiplier on every text length: a headline edit, a changed timestamp, a re-worded blurb. */
  textChurn?: number;
  /** Height of the rotating slot near the top: a different creative on every load. */
  slotHeight?: number;
  /** Device pixel ratio to REPORT, with every coordinate scaled to match. */
  devicePixelRatio?: number;
}

/** Deterministic 32-bit PRNG — the corpus must be byte-identical on every machine and every run. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Flow the description into boxes at a given viewport width. Column collapse and rail stacking are
 * driven by the width, which is what makes the narrow-viewport render a re-layout rather than a
 * squeeze.
 */
export function layoutPage(desc: PageDesc, viewportWidth: number, opts: LayoutOptions = {}): LayoutInput {
  const drift = opts.drift ?? 0;
  const churn = opts.textChurn ?? 1;
  const dpr = opts.devicePixelRatio ?? 1;
  const boxes: LayoutBox[] = [];
  const push = (x: number, y: number, w: number, h: number, t: number) => {
    boxes.push({ x: (x + drift) * dpr, y: (y + drift) * dpr, width: w * dpr, height: h * dpr, textLength: Math.round(t * churn) });
  };

  let y = 0;
  const stacked = viewportWidth < RAIL_BREAKPOINT_PX;
  const hasRail = desc.sections.some((s) => s.kind === 'rail');
  const railW = hasRail && !stacked ? Math.min(desc.railWidth, Math.floor(viewportWidth * 0.3)) : 0;
  const mainX = railW ? railW + GUTTER : 0;
  const mainW = viewportWidth - mainX;

  if (opts.slotHeight) {
    push(mainX, y, mainW, opts.slotHeight, 24);
    y += opts.slotHeight + GUTTER;
  }

  for (const s of desc.sections) {
    if (s.kind === 'rail') {
      // The rail flows in its own column beside the main content, or stacks above it when narrow.
      let ry = stacked ? y : 0;
      const rw = stacked ? viewportWidth : desc.railWidth;
      for (let i = 0; i < s.items; i++) {
        push(0, ry, rw, s.itemHeight, s.textPerItem);
        ry += s.itemHeight + 4;
      }
      if (stacked) y = ry + GUTTER;
      continue;
    }
    if (s.kind === 'card') {
      // A centred fixed-width block that does NOT stretch to the viewport — a login box, a consent
      // wall, a challenge interstitial. This is the only shape that leaves the page SHORTER AND
      // NARROWER than the viewport, and without at least one such page in the corpus the extent
      // normalisation always exceeds the viewport on both axes and divides the device pixel ratio
      // out on its own. A corpus made only of full-width pages therefore reports 100% DPR exactness
      // for a build with no DPR handling at all — measured, not theorised.
      const cardW = Math.min(360, viewportWidth);
      const cx = Math.max(0, Math.floor((viewportWidth - cardW) / 2));
      for (let i = 0; i < s.items; i++) {
        push(cx, y, cardW, s.itemHeight, s.textPerItem);
        y += s.itemHeight + 12;
      }
      y += GUTTER;
      continue;
    }
    if (s.kind === 'header' || s.kind === 'footer' || s.kind === 'hero') {
      push(0, y, viewportWidth, s.itemHeight, s.textPerItem);
      y += s.itemHeight + GUTTER;
      continue;
    }
    const cols = Math.max(1, Math.min(s.columns, Math.floor(mainW / MIN_COLUMN_PX)));
    const colW = Math.floor((mainW - GUTTER * (cols - 1)) / cols);
    for (let i = 0; i < s.items; i++) {
      const row = Math.floor(i / cols);
      const col = i % cols;
      push(mainX + col * (colW + GUTTER), y + row * (s.itemHeight + GUTTER), colW, s.itemHeight, s.textPerItem);
    }
    y += Math.ceil(s.items / cols) * (s.itemHeight + GUTTER);
  }

  return {
    boxes,
    viewport: { width: viewportWidth, height: 900, devicePixelRatio: dpr },
  };
}

const ARCHETYPES: Array<Omit<PageDesc, 'id'>> = [
  { railWidth: 240, sections: [{ kind: 'header', columns: 1, items: 1, itemHeight: 72, textPerItem: 40 }, { kind: 'grid', columns: 3, items: 12, itemHeight: 220, textPerItem: 160 }, { kind: 'footer', columns: 1, items: 1, itemHeight: 140, textPerItem: 90 }] },
  { railWidth: 260, sections: [{ kind: 'rail', columns: 1, items: 24, itemHeight: 28, textPerItem: 20 }, { kind: 'article', columns: 1, items: 9, itemHeight: 130, textPerItem: 520 }] },
  { railWidth: 200, sections: [{ kind: 'hero', columns: 1, items: 1, itemHeight: 380, textPerItem: 70 }, { kind: 'grid', columns: 4, items: 16, itemHeight: 160, textPerItem: 90 }, { kind: 'footer', columns: 1, items: 1, itemHeight: 200, textPerItem: 130 }] },
  { railWidth: 220, sections: [{ kind: 'header', columns: 1, items: 1, itemHeight: 56, textPerItem: 24 }, { kind: 'table', columns: 1, items: 40, itemHeight: 36, textPerItem: 180 }] },
  { railWidth: 300, sections: [{ kind: 'rail', columns: 1, items: 8, itemHeight: 90, textPerItem: 60 }, { kind: 'grid', columns: 2, items: 10, itemHeight: 260, textPerItem: 240 }] },
  { railWidth: 240, sections: [{ kind: 'header', columns: 1, items: 1, itemHeight: 64, textPerItem: 30 }, { kind: 'article', columns: 1, items: 4, itemHeight: 420, textPerItem: 1400 }, { kind: 'grid', columns: 3, items: 6, itemHeight: 150, textPerItem: 80 }] },
  // Compact: shorter AND narrower than the viewport, so the viewport floor binds. See the `card`
  // branch of `layoutPage` for why the corpus is worthless as a DPR measurement without this.
  { railWidth: 0, sections: [{ kind: 'card', columns: 1, items: 4, itemHeight: 90, textPerItem: 28 }] },
];

/** N deterministic page descriptions: each archetype re-parameterised by a seeded PRNG. */
export function buildCorpus(n = 30, seed = 0x5eed): PageDesc[] {
  const rnd = mulberry32(seed);
  const pages: PageDesc[] = [];
  for (let i = 0; i < n; i++) {
    const proto = ARCHETYPES[i % ARCHETYPES.length];
    pages.push({
      id: `page-${String(i).padStart(2, '0')}`,
      railWidth: Math.round(proto.railWidth * (0.8 + rnd() * 0.5)),
      sections: proto.sections.map((s) => ({
        ...s,
        items: Math.max(1, Math.round(s.items * (0.6 + rnd() * 0.9))),
        itemHeight: Math.max(20, Math.round(s.itemHeight * (0.7 + rnd() * 0.7))),
        textPerItem: Math.max(0, Math.round(s.textPerItem * (0.6 + rnd() * 0.9))),
      })),
    });
  }
  return pages;
}
