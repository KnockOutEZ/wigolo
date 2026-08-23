/**
 * G-S11a scoring over the CAPTURED corpus, with the signer as a parameter.
 *
 * This is `score.ts`'s arithmetic — same percentile convention, same different-page distribution,
 * same band test — applied to real captured renders instead of generated ones. It is a separate
 * module rather than an overload because the two corpora differ in what supplies the same-page
 * noise: `score.ts` MODELS re-render noise as drift plus text churn plus a rotating slot, while here
 * the noise is whatever two independent loads of the page actually did. Sharing one function would
 * have hidden that difference behind a parameter; sharing the arithmetic and not the corpus keeps
 * it visible, and the equivalence of the two implementations is asserted rather than asserted-in-a-
 * comment (see `tests/integration/visual-ldet-gate.test.ts`).
 *
 * Every function takes the signer, because a gate scored only against itself agrees with itself by
 * construction — the reason `score.ts:1-9` gives, and it did not stop applying when the corpus
 * became real.
 */
import { layoutDistance, type LayoutSignature } from '../../src/studio/layout/signature.js';
import { percentile, type Signer } from './score.js';
import { completePages, renderOf, type FrozenCorpus } from './corpus.js';

function crossPairs(sigs: readonly LayoutSignature[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < sigs.length; i++) {
    for (let j = i + 1; j < sigs.length; j++) out.push(layoutDistance(sigs[i], sigs[j]));
  }
  out.sort((a, b) => a - b);
  return out;
}

export interface RealSeparation {
  /** G-S11a-1 clause 1: same-build re-render pairs landing below the different-page 5th percentile. */
  separatedPct: number;
  crossP5: number;
  samePageP50: number;
  samePageWorst: number;
  pairs: number;
  pages: number;
}

/**
 * G-S11a-1 clause 1 on real pages. The two reference renders are two INDEPENDENT loads, so the
 * distance between them contains every real source of re-render noise at once — this is the clause
 * the synthetic corpus could only approximate.
 */
export function realSeparation(corpus: FrozenCorpus, sign: Signer): RealSeparation {
  const pages = completePages(corpus);
  const a: LayoutSignature[] = [];
  const b: LayoutSignature[] = [];
  for (const p of pages) {
    const ra = renderOf(p, 'ref_a');
    const rb = renderOf(p, 'ref_b');
    if (!ra || !rb) continue;
    a.push(sign(ra));
    b.push(sign(rb));
  }
  const cross = crossPairs(a);
  const p5 = percentile(cross, 5);
  const same = a.map((s, i) => layoutDistance(s, b[i]));
  const sorted = [...same].sort((x, y) => x - y);
  return {
    separatedPct: same.length ? (same.filter((d) => d < p5).length / same.length) * 100 : NaN,
    crossP5: p5,
    samePageP50: percentile(sorted, 50),
    samePageWorst: sorted.length ? sorted[sorted.length - 1] : NaN,
    pairs: cross.length,
    pages: a.length,
  };
}

export interface RealCrossViewport {
  width: number;
  /** G-S11a-1 clause 2: share of pages staying in the same-page band across the width change. */
  inBandPct: number;
  crossP5: number;
  medianDistance: number;
  /** Where the median same-page-across-widths distance sits inside the different-page distribution. */
  medianPercentileRank: number;
  worstPercentileRank: number;
  pages: number;
}

/**
 * G-S11a-1 clause 2 at ONE width. The width is a parameter and never a constant chosen here — the
 * spec does not state it, so the gate definition has to, and a function that hard-coded it would be
 * making that decision invisibly.
 *
 * The percentile RANK is reported alongside the band verdict because "fails the 5th-percentile
 * clause" covers both a near miss against a tight threshold and a total collapse, and those are
 * different findings about the normalisation.
 */
export function realCrossViewport(corpus: FrozenCorpus, sign: Signer, width: number): RealCrossViewport {
  const pages = completePages(corpus);
  const base: LayoutSignature[] = [];
  const alt: LayoutSignature[] = [];
  for (const p of pages) {
    const ra = renderOf(p, 'ref_a');
    const rw = renderOf(p, 'alt_width', width);
    if (!ra || !rw) continue;
    base.push(sign(ra));
    alt.push(sign(rw));
  }
  const cross = crossPairs(base);
  const p5 = percentile(cross, 5);
  const d = base.map((s, i) => layoutDistance(s, alt[i]));
  const ranks = d.map((x) => (cross.length ? (cross.filter((c) => c < x).length / cross.length) * 100 : NaN)).sort((x, y) => x - y);
  return {
    width,
    inBandPct: d.length ? (d.filter((x) => x < p5).length / d.length) * 100 : NaN,
    crossP5: p5,
    medianDistance: percentile([...d].sort((x, y) => x - y), 50),
    medianPercentileRank: percentile(ranks, 50),
    worstPercentileRank: ranks.length ? ranks[ranks.length - 1] : NaN,
    pages: d.length,
  };
}

/**
 * The L-DET "once at DPR 2" arm: the same page captured at a device scale factor of 2 must sign
 * exactly as it does at 1.
 *
 * Read this WITH `corpus.ts`'s `dprClauseJudgeable`. A perfect score here is only evidence about the
 * device-pixel-ratio HANDLING if the corpus contains renders the handling could have changed; on a
 * corpus where it could not, a perfect score is a tautology and the judgeability check says so.
 */
export function realDpr2Identical(corpus: FrozenCorpus, sign: Signer): { exactPct: number; pages: number } {
  const pages = completePages(corpus);
  let exact = 0;
  let n = 0;
  for (const p of pages) {
    const ra = renderOf(p, 'ref_a');
    const rd = renderOf(p, 'dpr2');
    if (!ra || !rd) continue;
    n++;
    if (layoutDistance(sign(ra), sign(rd)) === 0) exact++;
  }
  return { exactPct: n ? (exact / n) * 100 : NaN, pages: n };
}

/**
 * A stricter reading of the same arm, and the one that catches what the signature-level comparison
 * cannot: whether the two captures were the same GEOMETRY to begin with.
 *
 * If the browser engine returns identical bounds at both scale factors then every signer — shipped,
 * mutated, or constant — scores 100% on the clause above, and the clause is measuring the capture
 * path rather than the metric. That is a property of the corpus, so it is measured on the corpus.
 */
export interface Dpr2Attribution {
  pages: number;
  /** Captures whose boxes already differed at the two scale factors, before any signing. */
  geometryDiffers: number;
  /** Pages whose signature differs. */
  signatureDiffers: number;
  /**
   * Pages where the capture was byte-identical and the signature is NOT. Any page here is a defect
   * in the metric: identical input signing differently is non-determinism, and the count must be 0.
   */
  metricIntroduced: number;
  /** Pages whose capture differed and whose signature survived it — the normalisation absorbing real noise. */
  absorbed: number;
}

/**
 * WHERE a device-ratio difference comes from. The bare exactness percentage cannot distinguish "the
 * signature mishandles the ratio" from "the page genuinely renders differently at that ratio", and
 * those are opposite findings — one is a bug in the metric, the other is a fact about the web that
 * the metric is correctly reporting. So the two are separated by comparing the CAPTURES first.
 */
export function attributeDpr2(corpus: FrozenCorpus, sign: Signer): Dpr2Attribution {
  const pages = completePages(corpus);
  let geometryDiffers = 0;
  let signatureDiffers = 0;
  let metricIntroduced = 0;
  let absorbed = 0;
  let n = 0;
  for (const p of pages) {
    const ra = renderOf(p, 'ref_a');
    const rd = renderOf(p, 'dpr2');
    if (!ra || !rd) continue;
    n++;
    const geomSame =
      ra.boxes.length === rd.boxes.length &&
      ra.boxes.every((b, i) => {
        const o = rd.boxes[i];
        return b.x === o.x && b.y === o.y && b.width === o.width && b.height === o.height;
      });
    const sigSame = layoutDistance(sign(ra), sign(rd)) === 0;
    if (!geomSame) geometryDiffers++;
    if (!sigSame) signatureDiffers++;
    if (geomSame && !sigSame) metricIntroduced++;
    if (!geomSame && sigSame) absorbed++;
  }
  return { pages: n, geometryDiffers, signatureDiffers, metricIntroduced, absorbed };
}

/** Per-seed-group clause-2 verdicts, so a corpus-wide number is never mistaken for a uniform one. */
export function crossViewportByGroup(corpus: FrozenCorpus, sign: Signer, width: number): Array<{ group: string; inBandPct: number; pages: number }> {
  const pages = completePages(corpus);
  // The different-page distribution stays CORPUS-WIDE. Recomputing a 5th percentile inside a
  // six-page group would compare each group against a different threshold, and the columns would
  // stop being comparable — which is the whole point of splitting them out.
  const all = pages.map((p) => sign(renderOf(p, 'ref_a')!));
  const cross = crossPairs(all);
  const p5 = percentile(cross, 5);
  const byGroup = new Map<string, { inBand: number; n: number }>();
  pages.forEach((p, i) => {
    const alt = renderOf(p, 'alt_width', width);
    if (!alt) return;
    const g = byGroup.get(p.group) ?? { inBand: 0, n: 0 };
    g.n++;
    if (layoutDistance(all[i], sign(alt)) < p5) g.inBand++;
    byGroup.set(p.group, g);
  });
  return [...byGroup.entries()]
    .map(([group, g]) => ({ group, inBandPct: (g.inBand / g.n) * 100, pages: g.n }))
    .sort((a, b) => a.group.localeCompare(b.group));
}

export function dpr2GeometryDiffers(corpus: FrozenCorpus): { differing: number; pages: number } {
  const pages = completePages(corpus);
  let differing = 0;
  let n = 0;
  for (const p of pages) {
    const ra = renderOf(p, 'ref_a');
    const rd = renderOf(p, 'dpr2');
    if (!ra || !rd) continue;
    n++;
    if (ra.boxes.length !== rd.boxes.length) {
      differing++;
      continue;
    }
    const same = ra.boxes.every((b, i) => {
      const o = rd.boxes[i];
      return b.x === o.x && b.y === o.y && b.width === o.width && b.height === o.height;
    });
    if (!same) differing++;
  }
  return { differing, pages: n };
}
