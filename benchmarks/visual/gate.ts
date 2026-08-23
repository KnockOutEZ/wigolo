/**
 * G-S11a — MEASURED, on real captured pages.
 *
 *   npx tsx benchmarks/visual/capture.ts     # once, to freeze the corpus (network)
 *   npx tsx benchmarks/visual/gate.ts        # any time after, offline and deterministic
 *
 * WHAT MAKES THIS READABLE AS A VERDICT AND `runner.ts` NOT. `synth.ts:14-18` forbids reading a
 * G-S11a pass out of the synthetic runner, and that refusal stands — synthetic input measures the
 * metric's arithmetic and says nothing about the web. This scores the SAME arithmetic on ~40 real
 * pages captured through the shipped harvest (`capture.ts:12-19`), so the thing the synthetic
 * corpus could not answer — are real pages as separable as generated ones — is what this answers.
 *
 * THREE THINGS THIS PRINTS THAT A PASS/FAIL WOULD HIDE, each because the old runner hid one:
 *
 *   1. The SECOND VIEWPORT WIDTH. The spec's clause 2 says "a second viewport width" and never says
 *      which; the synthetic verdict swung 100% -> 30% across the plausible range, so the verdict was
 *      a function of an unstated number. The width is now captured as a sweep, PINNED in the gate
 *      definition below, and printed with every clause-2 verdict.
 *   2. CORPUS COMPOSITION. `score.ts:122-131`: the device-pixel-ratio clause's power is a property
 *      of which archetypes are present, and a corpus missing one reports a perfect score for a build
 *      with no handling at all. Composition is measured here and a clause whose precondition fails
 *      is printed as UNJUDGEABLE, never as a pass.
 *   3. WHICH MUTANT MOVES WHICH CLAUSE. A gate scored only against itself agrees with itself. The
 *      inversion table re-scores the same corpus with deliberately broken signers.
 *
 * This is NOT a vitest test and contributes zero to the suite count. The assertions that must red in
 * CI live in `tests/integration/visual-ldet-gate.test.ts`.
 */
import { existsSync } from 'node:fs';
import {
  LAYOUT_GRID_X,
  LAYOUT_GRID_Y,
  computeLayoutSignature,
  serializeLayoutSignature,
  MAX_SIGNATURE_BYTES,
} from '../../src/studio/layout/signature.js';
import { signerAt, type Signer } from './score.js';
import { constantSigner, noDprSigner, noWidthNormSigner } from './mutants.js';
import {
  CORPUS_PATH,
  MIN_CORPUS_PAGES,
  completePages,
  dprClauseJudgeable,
  loadCorpus,
  measureAdequacy,
  renderOf,
  type FrozenCorpus,
} from './corpus.js';
import { dpr2GeometryDiffers, realCrossViewport, realDpr2Identical, realSeparation } from './score-real.js';

/**
 * THE PINNED SECOND VIEWPORT WIDTH — part of the gate definition, not of the implementation.
 *
 * 1024 is the widest width in the sweep that crosses a real responsive breakpoint on the corpus's
 * rail-and-content group (a documentation site collapses its navigation rail below ~1100px), so it
 * exercises a genuine RE-FLOW rather than a re-wrap, while staying inside the desktop range the
 * clause is about. 1152 was rejected as too easy — on the synthetic corpus it scored 100% precisely
 * because nothing re-flows there — and 720 as a different question: at 720 the page is a phone
 * layout, and "the same page on a phone signs like the same page on a desktop" is not what D3's
 * portability claim asserts.
 *
 * Reversal condition: if the measured clause-2 verdict at 1024 turns out to be decided by ONE
 * archetype rather than by the corpus, the pin is wrong and the clause needs a per-archetype
 * verdict instead of a corpus-wide one. The per-width table below is what would show that.
 */
export const GATE_ALT_WIDTH = 1024;

const GRIDS: Array<[number, number]> = [[4, 6], [6, 8], [8, 10], [10, 12], [12, 16], [16, 20]];
const CLAUSE1_THRESHOLD = 95;
const CLAUSE2_THRESHOLD = 90;
const HARVEST_ROUND_TRIP_BUDGET = 1;
const QUANTISER_BUDGET_MS = 250;

const out = (s: string) => process.stdout.write(s);
const pct = (n: number) => `${n.toFixed(1)}%`;

function provenance(corpus: FrozenCorpus): void {
  const p = corpus.provenance;
  const complete = completePages(corpus);
  out('\nG-S11a — MEASURED on a REAL captured corpus (L-DET)\n\n');
  out('PROVENANCE\n');
  out(`  corpus            ${CORPUS_PATH}\n`);
  out(`  captured          ${p.capturedAt} on ${p.platform}\n`);
  out(`  browser engine    ${p.browserEngine} ${p.browserVersion}\n`);
  out(`  seeds attempted   ${p.attempted}, captured ${corpus.pages.length}, complete ${complete.length}\n`);
  out(`  reference render  ${p.refWidth}x${p.viewportHeight} CSS px, device scale factor 1, TWO independent page loads\n`);
  out(`  alternate widths  ${(p.altWidthSweep ?? [p.altWidth]).join(', ')} — gate PINNED at ${GATE_ALT_WIDTH}\n`);
  out(`  device-ratio arm  ${p.refWidth}x${p.viewportHeight} at device scale factor 2\n`);
  out(`  capture path      the shipped harvest over the browser engine's debug session (not a second reader)\n`);
  if (p.failures.length) {
    out(`  seeds that failed (${p.failures.length}):\n`);
    for (const f of p.failures) out(`    - ${f.url} — ${f.reason}\n`);
  }
}

function composition(corpus: FrozenCorpus): void {
  const a = measureAdequacy(corpus);
  out('\nCOMPOSITION — measured from the captured geometry, not from the seed list\n');
  out(`  pages scored           ${a.pages} (L-DET minimum ${MIN_CORPUS_PAGES})\n`);
  out(`  median boxes per page  ${a.medianBoxes}\n`);
  out(`  groups                 ${Object.entries(a.groups).map(([k, v]) => `${k}=${v}`).join('  ')}\n`);
  out(`  extent floor binds on both axes   ${a.floorBindingBoth} page(s)\n`);
  out(`  extent floor binds on either axis ${a.floorBindingEitherAxis} page(s)\n`);
  out(`  renders reporting a ratio != 1    ${a.rendersWithNonUnitDpr}\n`);
}

function clause1(corpus: FrozenCorpus): void {
  out('\nG-S11a-1 CLAUSE 1 — two renders of one page vs the different-page 5th percentile (>= 95%)\n\n');
  out('grid     samePage_p50  samePage_max  crossPage_p5  separated%  wireBytes\n');
  const rows = GRIDS.map(([gx, gy]) => {
    const s = realSeparation(corpus, signerAt(gx, gy));
    const wire = Math.max(
      ...completePages(corpus).map((p) => {
        const r = renderOf(p, 'ref_a');
        return r ? Buffer.byteLength(serializeLayoutSignature(computeLayoutSignature(r, { gridX: gx, gridY: gy })), 'utf8') : 0;
      }),
    );
    return { grid: `${gx}x${gy}`, s, wire };
  });
  for (const r of rows) {
    out(
      `${r.grid.padEnd(9)}${r.s.samePageP50.toFixed(3).padEnd(14)}${r.s.samePageWorst.toFixed(3).padEnd(14)}` +
      `${r.s.crossP5.toFixed(3).padEnd(14)}${pct(r.s.separatedPct).padEnd(12)}${r.wire}\n`,
    );
  }
  const clearing = rows.filter((r) => r.s.separatedPct >= CLAUSE1_THRESHOLD && r.wire <= MAX_SIGNATURE_BYTES);
  out(
    `\n  verdict: ${clearing.length ? 'PASS' : 'FAIL'} — ` +
    `${clearing.length ? `coarsest grid clearing it within the ${MAX_SIGNATURE_BYTES}B size budget is ${clearing[0].grid}` : `no grid reaches ${CLAUSE1_THRESHOLD}%`}\n`,
  );
  const shipped = rows.find((r) => r.grid === `${LAYOUT_GRID_X}x${LAYOUT_GRID_Y}`);
  if (shipped) out(`  at the SHIPPED grid ${shipped.grid}: ${pct(shipped.s.separatedPct)} over ${shipped.s.pages} pages, ${shipped.s.pairs} different-page pairs\n`);
}

function clause2(corpus: FrozenCorpus): void {
  const widths = corpus.provenance.altWidthSweep ?? [corpus.provenance.altWidth];
  out(`\nG-S11a-1 CLAUSE 2 — the same page across a width change, at the SHIPPED grid (>= 90%)\n\n`);
  out('secondWidth  inBand%   median_dist  median_rank  worst_rank\n');
  const rows = widths.map((w) => realCrossViewport(corpus, signerAt(), w));
  for (const r of rows) {
    out(
      `${String(r.width).padEnd(13)}${pct(r.inBandPct).padEnd(10)}${r.medianDistance.toFixed(3).padEnd(13)}` +
      `${pct(r.medianPercentileRank).padEnd(13)}${pct(r.worstPercentileRank)}\n`,
    );
  }
  const pinned = rows.find((r) => r.width === GATE_ALT_WIDTH);
  if (!pinned) {
    out(`\n  verdict: UNJUDGEABLE — the pinned width ${GATE_ALT_WIDTH} is not in the captured sweep\n`);
    return;
  }
  out(
    `\n  verdict at the PINNED second width ${GATE_ALT_WIDTH}px: ` +
    `${pinned.inBandPct >= CLAUSE2_THRESHOLD ? 'PASS' : 'FAIL'} (${pct(pinned.inBandPct)} over ${pinned.pages} pages)\n`,
  );
  out('  the width is part of the gate, not of this file — see GATE_ALT_WIDTH above for why 1024 and not 1152 or 720.\n');
}

function dprArm(corpus: FrozenCorpus): void {
  const adequacy = measureAdequacy(corpus);
  const judgeable = dprClauseJudgeable(adequacy);
  const exact = realDpr2Identical(corpus, signerAt());
  const geom = dpr2GeometryDiffers(corpus);
  out('\nL-DET DEVICE-RATIO ARM — the same page captured at a device scale factor of 2\n\n');
  out(`  signs identically      ${pct(exact.exactPct)} of ${exact.pages} pages\n`);
  out(`  captures that DIFFER   ${geom.differing} of ${geom.pages} pages, before any signing\n`);
  out(`  clause judgeable       ${judgeable.judgeable ? 'YES' : 'NO'} — ${judgeable.reason}\n`);
  if (!judgeable.judgeable) {
    out(
      '\n  So the 100% above is a TAUTOLOGY, not a pass, and it is printed as one. On this capture path\n' +
      '  the harvest reports a ratio of 1 for every page by construction (`harvest.ts:131-135`, and the\n' +
      '  reasoning at `:104-127`), so the ratio division is the identity and removing it changes nothing.\n' +
      '  What this arm DOES establish is the property the product actually depends on: a scale-factor\n' +
      '  change does not move the captured geometry, so it cannot move the signature.\n',
    );
  }
}

function costAndSize(corpus: FrozenCorpus): void {
  const pages = completePages(corpus);
  const sends = new Set<number>();
  let maxHarvestMs = 0;
  const harvestSamples: number[] = [];
  for (const p of pages) {
    for (const r of p.renders) {
      sends.add(r.sends);
      harvestSamples.push(r.harvestMs);
      maxHarvestMs = Math.max(maxHarvestMs, r.harvestMs);
    }
  }
  harvestSamples.sort((a, b) => a - b);

  // The heaviest real page in the corpus, re-quantised here so the p50 is this machine's number and
  // not the capture machine's.
  let biggest = pages[0] ? renderOf(pages[0], 'ref_a') : null;
  for (const p of pages) {
    const r = renderOf(p, 'ref_a');
    if (r && (!biggest || r.boxes.length > biggest.boxes.length)) biggest = r;
  }
  let quantP50 = NaN;
  if (biggest) {
    for (let i = 0; i < 20; i++) computeLayoutSignature(biggest);
    const s: number[] = [];
    for (let i = 0; i < 50; i++) {
      const t0 = performance.now();
      computeLayoutSignature(biggest);
      s.push(performance.now() - t0);
    }
    s.sort((a, b) => a - b);
    quantP50 = s[Math.floor(s.length / 2)];
  }

  const wire = Math.max(
    ...pages.map((p) => {
      const r = renderOf(p, 'ref_a');
      return r ? Buffer.byteLength(serializeLayoutSignature(computeLayoutSignature(r)), 'utf8') : 0;
    }),
  );

  out('\nG-S11a-2 — HARVEST COST (<= 1 round trip per page, <= 250 ms p50 added to an observe)\n\n');
  out(`  round trips per capture   ${[...sends].sort((a, b) => a - b).join(', ')} over ${pages.length} pages x ${pages[0]?.renders.length ?? 0} renders\n`);
  out(`  verdict                   ${sends.size === 1 && sends.has(HARVEST_ROUND_TRIP_BUDGET) ? 'PASS' : 'FAIL'}\n`);
  out(`  harvest wall clock p50    ${harvestSamples[Math.floor(harvestSamples.length / 2)]?.toFixed(1)} ms (max ${maxHarvestMs.toFixed(1)} ms) — includes the browser engine's own reply time\n`);
  out(`  quantiser p50             ${quantP50.toFixed(2)} ms on the corpus's heaviest page (${biggest?.boxes.length} boxes) — budget ${QUANTISER_BUDGET_MS} ms\n`);
  out(`  verdict                   ${quantP50 <= QUANTISER_BUDGET_MS ? 'PASS' : 'FAIL'}\n`);

  out('\nG-S11a-3 — SIZE (serialised signature <= 2 KB per page)\n\n');
  out(`  largest wire form         ${wire} bytes at the shipped grid ${LAYOUT_GRID_X}x${LAYOUT_GRID_Y}\n`);
  out(`  verdict                   ${wire <= MAX_SIGNATURE_BYTES ? 'PASS' : 'FAIL'}\n`);
}

function inversion(corpus: FrozenCorpus): void {
  const real = signerAt();
  const rows: Array<[string, Signer]> = [
    ['real (shipped)      ', real],
    ['M1 constant vector  ', constantSigner()],
    ['M2a no ratio divide ', noDprSigner()],
    ['M2b no width norm.  ', noWidthNormSigner()],
  ];
  out(`\nINVERSION PROBES on the REAL corpus at the shipped grid ${LAYOUT_GRID_X}x${LAYOUT_GRID_Y}\n\n`);
  out('signer                clause1   c2@1152  c2@1024  c2@720   dpr2exact\n');
  for (const [label, sign] of rows) {
    out(
      `${label}  ${pct(realSeparation(corpus, sign).separatedPct).padEnd(9)}` +
      `${pct(realCrossViewport(corpus, sign, 1152).inBandPct).padEnd(9)}` +
      `${pct(realCrossViewport(corpus, sign, 1024).inBandPct).padEnd(9)}` +
      `${pct(realCrossViewport(corpus, sign, 720).inBandPct).padEnd(9)}` +
      `${pct(realDpr2Identical(corpus, sign).exactPct)}\n`,
    );
  }
  out(
    '\n  M2a moves NOTHING here, and that is the honest result rather than a broken probe: the shipped\n' +
    '  harvest reports a device pixel ratio of 1 on every page, so there is no ratio for the mutation\n' +
    '  to remove. The synthetic corpus made this probe appear to fire by feeding a caller shape no\n' +
    '  shipped producer emits — device-px boxes with a CSS-px viewport and a true ratio — and even\n' +
    '  then only on the pages where the extent floor binds. The mutation is therefore re-scoped to a\n' +
    '  unit-level contract on that caller shape (`tests/unit/studio/layout/inversion-probes.test.ts`),\n' +
    '  and this corpus refuses to score it (see the device-ratio arm above) instead of reporting a pass.\n',
  );
  out(
    '  M4 (D5 clamp removed) is absent for the same structural reason as in the synthetic runner: the\n' +
    '  clamp is the identity on every box a real page produces, so no corpus score can detect its\n' +
    '  removal. Only the D5 unit assertions can.\n',
  );
}

function main(): void {
  if (!existsSync(CORPUS_PATH)) {
    out(
      `\nNo frozen corpus at ${CORPUS_PATH}.\n` +
      'Run `npx tsx benchmarks/visual/capture.ts` once (it needs network) and re-run this.\n\n',
    );
    process.exitCode = 1;
    return;
  }
  const corpus = loadCorpus();
  provenance(corpus);
  composition(corpus);
  const complete = completePages(corpus);
  if (complete.length < MIN_CORPUS_PAGES) {
    out(
      `\nREFUSING TO SCORE: ${complete.length} complete pages, and L-DET mandates >= ${MIN_CORPUS_PAGES}.\n` +
      'A shrunken corpus is a weaker gate wearing the same output, so it fails loudly instead.\n\n',
    );
    process.exitCode = 1;
    return;
  }
  clause1(corpus);
  clause2(corpus);
  dprArm(corpus);
  costAndSize(corpus);
  inversion(corpus);
  out('\n');
}

main();
