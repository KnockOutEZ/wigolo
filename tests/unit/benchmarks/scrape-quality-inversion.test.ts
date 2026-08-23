import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { measureInversionSweep, SWEEP_SEEDS } from '../../../benchmarks/scrape-quality/inversion-sweep.js';
import type { ScrapeManifest } from '../../../benchmarks/scrape-quality/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, '../../../benchmarks/scrape-quality/fixtures');
const HTML_DIR = join(FIXTURES, 'html');

const shipped = (): ScrapeManifest =>
  JSON.parse(readFileSync(join(FIXTURES, 'manifest.json'), 'utf-8')) as ScrapeManifest;

describe('inversion-probe reach (K24)', () => {
  it('discriminates monotonically on the shipped corpus, and total content loss is the loudest', async () => {
    // K24's number, turned from prose into a measurement. It was taken once by hand on the
    // browser lane (0 / 9 / 22 / 71 of 101) and then quoted in a triage row; a number that
    // lives only in prose is a number nobody can re-measure. The frozen lane reproduces it
    // exactly, because every seed removes the capability from the BYTES, upstream of any
    // renderer — which is what makes this cheap enough to guard on every run.
    const v = await measureInversionSweep({ manifest: shipped(), htmlDir: HTML_DIR });
    expect(v.violations).toEqual([]);
    expect(v.ok).toBe(true);

    const at = (s: string) => v.reaches.find((r) => r.seed === s)!;
    expect(at('none').reach).toBe(0);

    // The floors are K24's measured values. They are floors and not equalities on purpose: a
    // corpus that grows should push reach UP, and pinning an equality would turn every new
    // fixture into a failing test. What must never happen is reach going backwards, which is
    // the corpus going quieter about damage.
    expect(at('strip_headings').reach).toBeGreaterThanOrEqual(9);
    expect(at('strip_tables').reach).toBeGreaterThanOrEqual(22);
    expect(at('strip_body').reach).toBeGreaterThanOrEqual(71);

    // The K24 remedy itself: before `absent` carried a source precondition, an emptied document
    // left 30 of 101 compared assertions green. Requiring the probe to now reach a clear
    // majority of the corpus is what makes "the referee notices total content loss" checkable.
    const body = at('strip_body');
    expect(body.reach).toBeGreaterThan(body.compared * 0.8);
  }, 300_000);

  it('orders its seeds by increasing damage, which is what makes monotonicity mean anything', () => {
    expect(SWEEP_SEEDS).toEqual(['none', 'strip_headings', 'strip_tables', 'strip_body']);
  });

  it('FAILS when the corpus stops discriminating — the sweep can fire, not just agree', async () => {
    // The must-fail half. A corpus of assertions no damage can flip yields a flat reach curve;
    // that is a blind referee, and a sweep that reported it as healthy would be blind too.
    // `structured.tables >= 0` is satisfied by every document there is, including an empty one.
    const m = shipped();
    m.fixtures = m.fixtures.slice(0, 1).map((f) => ({
      ...f,
      assertions: [{ kind: 'structured', category: 'structured_extract', field: 'tables', min: 0, why: 'cannot fail' }],
    }));
    const v = await measureInversionSweep({ manifest: m, htmlDir: HTML_DIR });
    expect(v.ok).toBe(false);
    expect(v.violations.join(' ')).toMatch(/not strictly increasing/);
  }, 120_000);

  it('FAILS when the probe fires on an undamaged corpus', async () => {
    // The must-NOT-fire half. `runFixture` swallows nothing, so the only way `none` reaches an
    // assertion is a non-deterministic extractor — which would make every reach number noise.
    const m = shipped();
    m.fixtures = m.fixtures.slice(0, 2);
    const v = await measureInversionSweep({ manifest: m, htmlDir: HTML_DIR });
    expect(v.reaches.find((r) => r.seed === 'none')!.reach).toBe(0);
  }, 120_000);
});
