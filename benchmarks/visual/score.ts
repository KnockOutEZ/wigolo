/**
 * S11a gate scoring, with the SIGNER as a parameter.
 *
 * `runner.ts` scores the gates for ONE signer — the shipped `computeLayoutSignature`. That is enough
 * to print a number and not enough to know the number means anything: a metric scored only against
 * itself agrees with itself by construction. The spec's inversion probes (`:475-478`) need the SAME
 * scoring applied to a DELIBERATELY BROKEN signer so the two can be read side by side. Parameterising
 * the signer is what makes that possible without a second, drifting copy of the scoring arithmetic —
 * a probe scored by different code than the gate proves nothing about the gate.
 *
 * The scoring here reproduces `runner.ts` for the default signer: same corpus, same seed, same render
 * noise, same percentile convention. If the two ever disagree the probes are measuring a different
 * gate than the one that was reported, so that equivalence is ASSERTED in
 * `tests/unit/studio/layout/inversion-probes.test.ts` rather than left as a comment here.
 *
 * READ `synth.ts` FIRST. The corpus is SYNTHETIC. Every number produced here — for the real signer
 * and for every mutant — is a property of the metric's arithmetic on generated input, not of the web.
 * A probe that reds proves the metric is DOING the work the mutation removes; it does not promote the
 * gate from "passes on synthetic input" to "passes".
 */
import {
  computeLayoutSignature,
  layoutDistance,
  LAYOUT_GRID_X,
  LAYOUT_GRID_Y,
  type LayoutInput,
  type LayoutSignature,
} from '../../src/studio/layout/signature.js';
import { buildCorpus, layoutPage, mulberry32, type PageDesc } from './synth.js';

/** The width every corpus page's reference render is laid out at. Matches `runner.ts`. */
export const DESKTOP_WIDTH = 1280;
export const CORPUS_SIZE = 30;

/** Anything that turns a harvested layout into a signature — the real one, or a mutant. */
export type Signer = (input: LayoutInput) => LayoutSignature;

/** The shipped signer at a chosen grid. Defaults to the shipped grid. */
export function signerAt(gridX = LAYOUT_GRID_X, gridY = LAYOUT_GRID_Y): Signer {
  return (input) => computeLayoutSignature(input, { gridX, gridY });
}

export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/** Every unordered pair of reference renders — the different-page distribution every gate is scored against. */
function crossPairs(sigs: readonly LayoutSignature[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < sigs.length; i++) {
    for (let j = i + 1; j < sigs.length; j++) out.push(layoutDistance(sigs[i], sigs[j]));
  }
  out.sort((a, b) => a - b);
  return out;
}

export interface SeparationScore {
  /** G-S11a-1 clause 1: share of pages whose two same-build renders land below the different-page p5. */
  separatedPct: number;
  crossP5: number;
  samePageP50: number;
  /** How many different-page pairs the p5 was taken over — 435 for a 30-page corpus. */
  pairs: number;
}

/**
 * G-S11a-1 clause 1. Two renders of one page on one build, against the 5th percentile of
 * different-page distances.
 *
 * The second render carries the noise a same-page pair has to survive: sub-pixel drift, a small text
 * edit, and a rotating slot whose creative is a different height on every load.
 */
export function scoreSeparation(sign: Signer, pages: readonly PageDesc[] = buildCorpus(CORPUS_SIZE)): SeparationScore {
  const rnd = mulberry32(0xc0ffee);
  const a: LayoutSignature[] = [];
  const b: LayoutSignature[] = [];
  for (const p of pages) {
    a.push(sign(layoutPage(p, DESKTOP_WIDTH, { slotHeight: 90 })));
    b.push(sign(layoutPage(p, DESKTOP_WIDTH, {
      drift: 0.4 + rnd() * 0.4,
      textChurn: 0.97 + rnd() * 0.06,
      slotHeight: 90 + Math.round(rnd() * 40),
    })));
  }
  const cross = crossPairs(a);
  const p5 = percentile(cross, 5);
  const same = a.map((s, i) => layoutDistance(s, b[i]));
  return {
    separatedPct: (same.filter((d) => d < p5).length / same.length) * 100,
    crossP5: p5,
    samePageP50: percentile([...same].sort((x, y) => x - y), 50),
    pairs: cross.length,
  };
}

export interface CrossViewportScore {
  /** G-S11a-1 clause 2: share of pages that stay in the same-page band across the width change. */
  inBandPct: number;
  crossP5: number;
  medianDistance: number;
}

/**
 * G-S11a-1 clause 2, at ONE second width. The spec never states how much narrower the second
 * viewport is, so the width is a parameter and never a constant chosen here.
 */
export function scoreCrossViewport(sign: Signer, width: number, pages: readonly PageDesc[] = buildCorpus(CORPUS_SIZE)): CrossViewportScore {
  const base = pages.map((p) => sign(layoutPage(p, DESKTOP_WIDTH, { slotHeight: 90 })));
  const alt = pages.map((p) => sign(layoutPage(p, width, { slotHeight: 90 })));
  const cross = crossPairs(base);
  const p5 = percentile(cross, 5);
  const d = base.map((s, i) => layoutDistance(s, alt[i]));
  return {
    inBandPct: (d.filter((x) => x < p5).length / d.length) * 100,
    crossP5: p5,
    medianDistance: percentile([...d].sort((x, y) => x - y), 50),
  };
}

/**
 * D3's device-pixel-ratio half: the same render reported in device px at DPR 2 must sign EXACTLY as
 * it does in CSS px at DPR 1.
 *
 * `synth.ts:154-156` is load-bearing for this number. Only the `card` archetype leaves a page shorter
 * AND narrower than the viewport, and only then does the viewport floor of the extent normalisation
 * bind. On every other archetype the extent normalisation divides the DPR factor out on its own, so
 * those pages score exact for a build with NO DPR handling at all. That is why this number does not
 * fall to zero when the DPR division is removed — see the normalisation probe.
 */
export function scoreDprExact(sign: Signer, pages: readonly PageDesc[] = buildCorpus(CORPUS_SIZE)): number {
  const base = pages.map((p) => sign(layoutPage(p, DESKTOP_WIDTH, { slotHeight: 90 })));
  const dpr2 = pages.map((p) => sign(layoutPage(p, DESKTOP_WIDTH, { slotHeight: 90, devicePixelRatio: 2 })));
  return (base.filter((s, i) => layoutDistance(s, dpr2[i]) === 0).length / base.length) * 100;
}
