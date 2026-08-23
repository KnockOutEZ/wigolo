/**
 * K24 — the inversion probe's REACH, as a measured, reproducible number.
 *
 * The probe's discrimination (0 / 9 / 22 / 71 across the four seeds) was measured once, by
 * hand, on the browser lane, and then quoted in a triage row. A number that lives only in prose
 * is a number nobody can re-measure — and this program has been bitten three times by exactly
 * that, most recently by §8-A's "+5 at ~30" against a corpus of 19.
 *
 * So the sweep is code. Two properties make it cheap enough to run on every PR:
 *
 *  - It runs on the FROZEN lane. `applySeed` is a pure string transform and `compareLanes`
 *    compares two `ScrapeReport`s; neither needs a browser. The frozen lane reproduces the
 *    browser lane's numbers exactly (verified: 0 / 9 / 22 / 71 at compared=101), because the
 *    seeds remove the capability from the BYTES, upstream of any renderer.
 *  - It is a differential in one process on one corpus — clean run vs seeded run — so a
 *    machine, a dependency bump or a corpus edit cannot move one arm without moving the other.
 *
 * What it gates is not the reach VALUE but the reach SHAPE: strictly increasing with damage,
 * and non-zero for every seed that removes something. A probe whose reach stops growing as the
 * damage grows has gone partly blind, which is the defect K24 named.
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../../src/logger.js';
import { applySeed, compareLanes, type LiveSeed } from './live-lane.js';
import { loadManifest, runFixture } from './runner.js';
import { summarise } from './score.js';
import type { FixtureResult, ScrapeManifest, ScrapeReport } from './types.js';

const log = createLogger('extract');
const here = dirname(fileURLToPath(import.meta.url));

/**
 * The seeds in INCREASING order of damage, which is what makes monotonicity a meaningful
 * claim: `strip_headings` removes one markdown feature, `strip_tables` removes a feature plus
 * every structured table derived from it, `strip_body` removes the document.
 */
export const SWEEP_SEEDS: LiveSeed[] = ['none', 'strip_headings', 'strip_tables', 'strip_body'];

export interface SeedReach {
  seed: LiveSeed;
  /** Assertions whose verdict differs from the clean run — the probe's reach at this seed. */
  reach: number;
  /** Assertions actually compared (after the visibility-class exclusions). */
  compared: number;
}

export interface SweepVerdict {
  ok: boolean;
  reaches: SeedReach[];
  violations: string[];
}

async function runSeeded(manifest: ScrapeManifest, htmlDir: string, seed: LiveSeed): Promise<ScrapeReport> {
  const results: FixtureResult[] = [];
  for (const f of manifest.fixtures) {
    const path = join(htmlDir, f.htmlPath);
    // Same hard-error-on-missing rule as both lanes. A sweep that skipped a missing snapshot
    // would report a smaller reach and read as a quieter probe rather than a broken one.
    if (!existsSync(path)) throw new Error(`fixture snapshot missing: ${path} (referenced by ${f.id})`);
    results.push(await runFixture(f, applySeed(readFileSync(path, 'utf-8'), seed)));
  }
  return summarise(results, 0, new Date().toISOString());
}

export async function measureInversionSweep(opts: { manifest: ScrapeManifest; htmlDir: string }): Promise<SweepVerdict> {
  const clean = await runSeeded(opts.manifest, opts.htmlDir, 'none');
  const reaches: SeedReach[] = [];
  for (const seed of SWEEP_SEEDS) {
    const damaged = seed === 'none' ? clean : await runSeeded(opts.manifest, opts.htmlDir, seed);
    const parity = compareLanes(opts.manifest, clean, damaged);
    reaches.push({ seed, reach: parity.mismatches.length, compared: parity.compared });
  }

  const violations: string[] = [];
  const at = (s: LiveSeed) => reaches.find((r) => r.seed === s)!;

  // The unseeded arm is the must-NOT-fire half. A probe that reports damage on a clean corpus
  // is indistinguishable from one that reports it on a real regression.
  if (at('none').reach !== 0) violations.push(`seed 'none' reaches ${at('none').reach} assertion(s): the probe fires on an undamaged corpus`);

  for (let i = 1; i < reaches.length; i += 1) {
    const prev = reaches[i - 1]!;
    const cur = reaches[i]!;
    if (cur.reach <= prev.reach) {
      violations.push(`reach is not strictly increasing: '${prev.seed}'=${prev.reach} then '${cur.seed}'=${cur.reach} — the probe stopped discriminating as the damage grew`);
    }
  }

  // Total content loss is the loudest damage there is. If it does not reach nearly every
  // compared assertion, some assertion kind is satisfied by an empty document by construction
  // — the exact ceiling K24 measured at 71/101 before `absent` gained a source precondition.
  const body = at('strip_body');
  if (body.compared > 0 && body.reach < body.compared) {
    const survivors = body.compared - body.reach;
    log.warn('strip_body leaves assertions green', { survivors, compared: body.compared });
  }

  return { ok: violations.length === 0, reaches, violations };
}

export function renderSweep(v: SweepVerdict): string {
  const lines: string[] = ['# Inversion-probe reach (K24)', ''];
  lines.push('Each seed removes a CAPABILITY from the served bytes, upstream of extraction.');
  lines.push('Reach = assertions whose verdict differs from the clean run on the same corpus,');
  lines.push('in the same process. Damage increases down the table, so reach must too.', '');
  lines.push('| Seed | Reach | Compared | Fraction |', '|---|---:|---:|---:|');
  for (const r of v.reaches) {
    const frac = r.compared === 0 ? 'n/a' : (r.reach / r.compared).toFixed(3);
    lines.push(`| ${r.seed} | ${r.reach} | ${r.compared} | ${frac} |`);
  }
  lines.push('', '## Violations', '');
  lines.push(v.violations.length ? v.violations.map((x) => `- ❌ ${x}`).join('\n') : '_none_');
  lines.push('', v.ok ? '✅ probe discriminates monotonically' : '❌ probe discrimination REGRESSED');
  return `${lines.join('\n')}\n`;
}

async function main(): Promise<void> {
  const manifest = loadManifest();
  const verdict = await measureInversionSweep({ manifest, htmlDir: join(here, 'fixtures', 'html') });

  const outDir = join(here, 'output');
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const rendered = renderSweep(verdict);
  writeFileSync(join(outDir, 'inversion-sweep.json'), `${JSON.stringify(verdict, null, 2)}\n`, 'utf-8');
  writeFileSync(join(outDir, 'inversion-sweep.md'), rendered, 'utf-8');
  process.stderr.write(rendered);

  if (!verdict.ok) {
    log.error('inversion sweep FAILED', { violations: verdict.violations.length });
    process.exitCode = 1;
  }
}

// Entry guard — see corpus-gate.ts.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    log.error('inversion sweep crashed', { error: String(err) });
    process.exitCode = 1;
  });
}
