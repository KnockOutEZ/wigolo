/**
 * S11a gate runner — G-S11a-1 (separation), G-S11a-2 (harvest cost), G-S11a-3 (size), plus the
 * spec 6.1 grid sweep.
 *
 *   npx tsx benchmarks/visual/runner.ts
 *
 * (There is no `bench:visual` npm script yet: `package.json` was outside this slice's allowed file
 * set, so the one-line script entry is left for whoever owns that file.)
 *
 * This is NOT a vitest test and contributes zero to the suite count — the suite arithmetic in the
 * spec depends on that staying true, so do not add `.test.ts` to anything in this directory.
 *
 * READ `synth.ts` BEFORE READING A NUMBER OUT OF THIS RUNNER. The corpus is synthetic. It measures
 * the metric's arithmetic, not the web's behaviour, and a pass here is not G-S11a-1 passing.
 */
import {
  computeLayoutSignature,
  layoutDistance,
  serializeLayoutSignature,
  LAYOUT_GRID_X,
  LAYOUT_GRID_Y,
  type LayoutSignature,
} from '../../src/studio/layout/signature.js';
import { buildCorpus, layoutPage, mulberry32 } from './synth.js';
import { scoreSeparation, scoreCrossViewport, scoreDprExact, signerAt, type Signer } from './score.js';
import { constantSigner, noDprSigner, noWidthNormSigner } from './mutants.js';

const DESKTOP = 1280;
const NARROW = 720;
const GRIDS: Array<[number, number]> = [[4, 6], [6, 8], [8, 10], [10, 12], [12, 16], [16, 20]];

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

interface GridScore {
  grid: string;
  samePageP50: number;
  crossPageP5: number;
  separatedPct: number;
  crossViewportPct: number;
  dprExactPct: number;
  wireBytes: number;
}

function scoreGrid(gridX: number, gridY: number): GridScore {
  const pages = buildCorpus(30);
  const rnd = mulberry32(0xc0ffee);
  const opts = { gridX, gridY };

  const renderA: LayoutSignature[] = [];
  const renderB: LayoutSignature[] = [];
  const narrow: LayoutSignature[] = [];
  const dpr2: LayoutSignature[] = [];

  for (const p of pages) {
    // Two renders on the same build: sub-pixel drift, a small text edit, and a rotating slot whose
    // creative is a different height each load — the noise a same-page pair must survive.
    renderA.push(computeLayoutSignature(layoutPage(p, DESKTOP, { slotHeight: 90 }), opts));
    renderB.push(computeLayoutSignature(
      layoutPage(p, DESKTOP, { drift: 0.4 + rnd() * 0.4, textChurn: 0.97 + rnd() * 0.06, slotHeight: 90 + Math.round(rnd() * 40) }),
      opts,
    ));
    narrow.push(computeLayoutSignature(layoutPage(p, NARROW, { slotHeight: 90 }), opts));
    dpr2.push(computeLayoutSignature(layoutPage(p, DESKTOP, { slotHeight: 90, devicePixelRatio: 2 }), opts));
  }

  const cross: number[] = [];
  for (let i = 0; i < renderA.length; i++) {
    for (let j = i + 1; j < renderA.length; j++) cross.push(layoutDistance(renderA[i], renderA[j]));
  }
  cross.sort((a, b) => a - b);
  const p5 = percentile(cross, 5);

  const same = renderA.map((a, i) => layoutDistance(a, renderB[i]));
  const separated = same.filter((d) => d < p5).length / same.length;
  const viewportOk = narrow.filter((n, i) => layoutDistance(renderA[i], n) < p5).length / narrow.length;
  const dprOk = dpr2.filter((d, i) => layoutDistance(renderA[i], d) === 0).length / dpr2.length;
  const wireBytes = Math.max(...renderA.map((s) => Buffer.byteLength(serializeLayoutSignature(s), 'utf8')));

  return {
    grid: `${gridX}x${gridY}`,
    samePageP50: percentile([...same].sort((a, b) => a - b), 50),
    crossPageP5: p5,
    separatedPct: separated * 100,
    crossViewportPct: viewportOk * 100,
    dprExactPct: dprOk * 100,
    wireBytes,
  };
}

function harvestCost(): { quantiserP50Ms: number; boxes: number } {
  // The round-trip budget itself is asserted on a counting fake transport in
  // tests/unit/studio/layout/harvest.test.ts — a counter cannot agree with the code by accident the
  // way a wall clock can. What is left to measure here is the pure quantiser's own cost on a page
  // larger than the ~900-element page the perception layer was measured against.
  const boxes = Array.from({ length: 3000 }, (_, i) => ({
    x: (i * 37) % 1240, y: (i * 53) % 9000, width: 120 + (i % 40), height: 24 + (i % 12), textLength: (i * 7) % 300,
  }));
  const input = { boxes, viewport: { width: 1280, height: 900, devicePixelRatio: 1 } };
  for (let i = 0; i < 20; i++) computeLayoutSignature(input); // warm
  const samples: number[] = [];
  for (let i = 0; i < 50; i++) {
    const t0 = performance.now();
    computeLayoutSignature(input);
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  return { quantiserP50Ms: samples[Math.floor(samples.length / 2)], boxes: boxes.length };
}

/**
 * The spec's inversion probes (`:475-478`) as a BEFORE/AFTER table.
 *
 * The gate table above is a metric scored against itself; on its own it cannot distinguish "the
 * signature separates pages" from "the scoring cannot tell the difference". These rows break the
 * signature one way at a time and re-score, so the gate numbers acquire a signal from outside
 * themselves. The pass/fail assertions live in `tests/unit/studio/layout/inversion-probes.test.ts`
 * (which is where they can red in CI); this table exists so the NUMBERS can be read without one.
 *
 * The per-node harvest probe is not here: its gate is a CDP send counter, not a corpus score, and it
 * is asserted on a counting fake transport in that same test file.
 */
function inversionTable(): void {
  const fmt = (n: number) => `${n.toFixed(1)}%`.padEnd(8);
  const real = signerAt(LAYOUT_GRID_X, LAYOUT_GRID_Y);
  const rows: Array<[string, Signer]> = [
    ['real (shipped)      ', real],
    ['M1 constant vector  ', constantSigner()],
    ['M2a no DPR division ', noDprSigner()],
    ['M2b no width norm.  ', noWidthNormSigner()],
  ];
  process.stdout.write(`\nINVERSION PROBES at grid ${LAYOUT_GRID_X}x${LAYOUT_GRID_Y} (each mutant must move the gate it targets)\n\n`);
  process.stdout.write('signer                clause1  c2@1152  c2@1024  c2@720   dprExact\n');
  for (const [label, sign] of rows) {
    process.stdout.write(
      `${label}  ${fmt(scoreSeparation(sign).separatedPct)} ${fmt(scoreCrossViewport(sign, 1152).inBandPct)} ` +
      `${fmt(scoreCrossViewport(sign, 1024).inBandPct)} ${fmt(scoreCrossViewport(sign, 720).inBandPct)} ` +
      `${fmt(scoreDprExact(sign))}\n`,
    );
  }
  // The DPR probe's own precondition. `synth.ts:154-156` says only the `card` archetype makes the
  // viewport floor bind; drop those pages and a build with NO DPR handling scores a perfect gate.
  const cardFree = buildCorpus(30).filter((_, i) => i % 7 !== 6);
  process.stdout.write(
    `\nM2a on a corpus with the \`card\` archetype REMOVED: real ${scoreDprExact(real, cardFree).toFixed(1)}%, ` +
    `mutant ${scoreDprExact(noDprSigner(), cardFree).toFixed(1)}% — the probe goes BLIND without those pages.\n`,
  );
  // The clamp probe is not a corpus score for a structural reason worth printing next to the table.
  process.stdout.write(
    'M4 (D5 clamp removed) moves NO number above: `clampCoord` is the identity on every box this\n' +
    'corpus produces, so G-S11a-1 cannot detect its removal. Only the D5 unit assertions can.\n',
  );
}

function main(): void {
  const rows = GRIDS.map(([x, y]) => scoreGrid(x, y));
  const fmt = (n: number, d = 3) => n.toFixed(d);
  process.stdout.write('\nS11a / L-DET (SYNTHETIC CORPUS — see synth.ts before quoting any number)\n\n');
  process.stdout.write('grid    samePage_p50  crossPage_p5  separated%  crossViewport%  dprExact%  wireBytes\n');
  for (const r of rows) {
    process.stdout.write(
      `${r.grid.padEnd(8)}${fmt(r.samePageP50).padEnd(14)}${fmt(r.crossPageP5).padEnd(14)}` +
      `${fmt(r.separatedPct, 1).padEnd(12)}${fmt(r.crossViewportPct, 1).padEnd(16)}` +
      `${fmt(r.dprExactPct, 1).padEnd(11)}${r.wireBytes}\n`,
    );
  }

  // G-S11a-1 has TWO clauses and they must be reported separately: they came out differently, and
  // collapsing them into one pass/fail would hide which half of the design is in question.
  const sepOk = rows.filter((r) => r.separatedPct >= 95 && r.wireBytes <= 2048);
  const bothOk = sepOk.filter((r) => r.crossViewportPct >= 90);
  process.stdout.write(
    `\nG-S11a-1 clause 1 (same-page vs different-page, >=95%): ` +
    `${sepOk.length ? `PASS at every grid; coarsest clearing it with wire<=2048B is ${sepOk[0].grid}` : 'FAIL'}\n`,
  );
  process.stdout.write(
    `G-S11a-1 clause 2 (same page across viewport widths, >=90%): ` +
    `${bothOk.length ? `PASS at ${bothOk[0].grid}` : `FAIL at every grid in the sweep against a ${NARROW}px second width`}\n`,
  );
  process.stdout.write(
    'NOTE: clause 2 does not state HOW MUCH narrower the second viewport is, and the diagnostic\n' +
    'below shows the verdict is entirely determined by that unstated number. Do not read either\n' +
    'result as settled until the second width is decided.\n',
  );

  // WHERE do cross-viewport pairs land? "Fails the 5th-percentile clause" covers both a near miss
  // against a very tight threshold and a total collapse, and those are different findings. Report
  // the percentile RANK of each same-page-across-widths distance inside the different-page
  // distribution, and separate a width change that does NOT collapse columns (1280 -> 1024) from
  // one that does (1280 -> 720). If the first is clean and the second is not, the limit is REFLOW,
  // not the width normalisation.
  process.stdout.write('\ncross-viewport diagnostic at grid 8x10 (percentile rank inside the different-page distribution)\n');
  for (const width of [1152, 1024, 900, 720, 480]) {
    const pages = buildCorpus(30);
    const opts = { gridX: 8, gridY: 10 };
    const base = pages.map((p) => computeLayoutSignature(layoutPage(p, DESKTOP, { slotHeight: 90 }), opts));
    const alt = pages.map((p) => computeLayoutSignature(layoutPage(p, width, { slotHeight: 90 }), opts));
    const cross: number[] = [];
    for (let i = 0; i < base.length; i++) for (let j = i + 1; j < base.length; j++) cross.push(layoutDistance(base[i], base[j]));
    cross.sort((a, b) => a - b);
    const ranks = base.map((b, i) => {
      const d = layoutDistance(b, alt[i]);
      return (cross.filter((c) => c < d).length / cross.length) * 100;
    });
    ranks.sort((a, b) => a - b);
    const meds = base.map((b, i) => layoutDistance(b, alt[i])).sort((a, b) => a - b);
    process.stdout.write(
      `  ${DESKTOP} -> ${String(width).padEnd(5)} median distance ${fmt(meds[Math.floor(meds.length / 2)])}  ` +
      `median percentile rank ${fmt(ranks[Math.floor(ranks.length / 2)], 1)}%  worst ${fmt(ranks[ranks.length - 1], 1)}%\n`,
    );
  }

  inversionTable();

  const cost = harvestCost();
  process.stdout.write(`\nquantiser p50 on a ${cost.boxes}-box page: ${cost.quantiserP50Ms.toFixed(2)} ms (budget: 250 ms)\n`);
  process.stdout.write('round-trip budget (G-S11a-2) is asserted in tests/unit/studio/layout/harvest.test.ts, not here\n\n');
}

main();
