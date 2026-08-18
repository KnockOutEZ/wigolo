import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateAssertion, summarise } from '../../../benchmarks/scrape-quality/score.js';
import {
  applySeed,
  compareLanes,
  runLiveLane,
  serveFixtures,
  VISIBILITY_CLASSES,
  type LivePageReader,
} from '../../../benchmarks/scrape-quality/live-lane.js';
import { validateCorpus, CORPUS_TARGETS } from '../../../benchmarks/scrape-quality/corpus-gate.js';
import {
  mutate,
  validateDriftCorpus,
  MUTATION_CLASSES,
  type DriftManifest,
} from '../../../benchmarks/scrape-quality/drift.js';
import type {
  Assertion,
  AssertionContext,
  FixtureResult,
  ReplayOutcome,
  ScrapeManifest,
} from '../../../benchmarks/scrape-quality/types.js';
import type { StructuredData } from '../../../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, '../../../benchmarks/scrape-quality/fixtures');
const HTML_DIR = join(FIXTURES, 'html');

const EMPTY_STRUCTURED: StructuredData = {
  tables: [], definitions: [], jsonld: [], chart_hints: [], key_value_pairs: [],
};

const replay = (o: Partial<ReplayOutcome> = {}): AssertionContext => ({
  replay: { columns: ['name', 'price'], rowCount: 10, healTier: 'high', ...o },
});

// ---------------------------------------------------------------------------
// visible_only — the assertion kind that carries a non-vacuity obligation
// ---------------------------------------------------------------------------

describe('visible_only assertion', () => {
  const a: Assertion = {
    kind: 'visible_only',
    category: 'boilerplate_noise',
    value: 'Secret draft paragraph',
    why: 'test',
  };
  const html = '<html><body><p style="display:none">Secret draft paragraph</p><p>Shown</p></body></html>';

  it('passes when invisible source text does not survive extraction', () => {
    const r = evaluateAssertion(a, 'Shown', EMPTY_STRUCTURED, { sourceHtml: html });
    expect(r.passed).toBe(true);
  });

  it('fails when invisible content leaks into the extracted markdown', () => {
    // This is the whole point of the kind: WYSIWYG means the human's view is the contract,
    // and text they cannot see must not arrive in an agent's context as though they could.
    const r = evaluateAssertion(a, 'Shown\nSecret draft paragraph', EMPTY_STRUCTURED, { sourceHtml: html });
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/leaked/);
  });

  it('FAILS as vacuous when the value is not in the source HTML at all', () => {
    // The anti-vacuity guard. Without it, a fixture typo produces an assertion that can never
    // fail — it would score a free point for the life of the corpus and read as coverage.
    // A control must remove the capability, and here the capability is "there is something to
    // suppress"; with nothing to suppress the assertion measures nothing and must say so.
    const r = evaluateAssertion(a, 'Shown', EMPTY_STRUCTURED, { sourceHtml: '<html><body><p>Shown</p></body></html>' });
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/VACUOUS/);
  });

  it('FAILS rather than passes when no source HTML is supplied', () => {
    // A missing input reading as a pass is how a detector goes blind without anyone noticing.
    const r = evaluateAssertion(a, 'Shown', EMPTY_STRUCTURED, {});
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/not evaluated/);
  });

  it('sees through tags and entities, so markup cannot hide a present value', () => {
    // The non-vacuity check reads TEXT, not raw source. If it matched raw bytes, any value
    // split by inline markup would read as "absent from the HTML" and the assertion would be
    // discarded as vacuous — turning the guard into a way to lose real coverage.
    const spaced: Assertion = { ...a, value: 'Secret draft' };
    const wrapped = '<html><body><div hidden><b>Secret</b>&nbsp;draft paragraph</div></body></html>';
    const r = evaluateAssertion(spaced, 'nothing', EMPTY_STRUCTURED, { sourceHtml: wrapped });
    expect(r.passed).toBe(true);
    expect(r.detail).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The three replay assertion kinds
// ---------------------------------------------------------------------------

describe('replay assertion kinds', () => {
  const cols: Assertion = { kind: 'row_columns', category: 'structured_extract', expect: ['name', 'price'], why: 'test' };
  const count: Assertion = { kind: 'row_count', category: 'structured_extract', min: 5, max: 20, why: 'test' };
  const heal: Assertion = { kind: 'heal_at_least', category: 'structured_extract', tier: 'medium', why: 'test' };

  it('row_columns passes on the recorded column set regardless of order', () => {
    const r = evaluateAssertion(cols, '', EMPTY_STRUCTURED, replay({ columns: ['price', 'name'] }));
    expect(r.passed).toBe(true);
  });

  it('row_columns fails on a different column set and names what it actually got', () => {
    const r = evaluateAssertion(cols, '', EMPTY_STRUCTURED, replay({ columns: ['name'] }));
    expect(r.passed).toBe(false);
    expect(r.detail).toBe('actual [name]');
  });

  it('row_count fails outside the recorded bounds', () => {
    expect(evaluateAssertion(count, '', EMPTY_STRUCTURED, replay({ rowCount: 10 })).passed).toBe(true);
    expect(evaluateAssertion(count, '', EMPTY_STRUCTURED, replay({ rowCount: 21 })).passed).toBe(false);
  });

  it('heal_at_least treats the tier as a FLOOR, not an equality', () => {
    expect(evaluateAssertion(heal, '', EMPTY_STRUCTURED, replay({ healTier: 'high' })).passed).toBe(true);
    expect(evaluateAssertion(heal, '', EMPTY_STRUCTURED, replay({ healTier: 'medium' })).passed).toBe(true);
    expect(evaluateAssertion(heal, '', EMPTY_STRUCTURED, replay({ healTier: 'low' })).passed).toBe(false);
    expect(evaluateAssertion(heal, '', EMPTY_STRUCTURED, replay({ healTier: 'none' })).passed).toBe(false);
  });

  it('a `high` floor is not satisfied by a `medium` heal', () => {
    // §11 item 7's silent-degradation case. If this floor were satisfied by any resolve at
    // all, the corpus could not distinguish "healed as authored" from "healed worse and served
    // rows anyway", which is the exact shape §8-B's silent-wrong gate is built to catch.
    const strict: Assertion = { ...heal, tier: 'high' };
    expect(evaluateAssertion(strict, '', EMPTY_STRUCTURED, replay({ healTier: 'medium' })).passed).toBe(false);
  });

  it.each([['row_columns', cols], ['row_count', count], ['heal_at_least', heal]] as const)(
    '%s FAILS rather than passes with no replay outcome',
    (_name, assertion) => {
      // These kinds are unevaluable on an extraction-only lane. Passing them there would make
      // the C0 gate report coverage it does not have.
      const r = evaluateAssertion(assertion, '', EMPTY_STRUCTURED, {});
      expect(r.passed).toBe(false);
      expect(r.detail).toBe('not evaluated: no replay outcome');
    },
  );
});

// ---------------------------------------------------------------------------
// The loopback fixture server
// ---------------------------------------------------------------------------

describe('loopback fixture server', () => {
  it('serves an allow-listed fixture and 404s everything else', async () => {
    const server = await serveFixtures(new Map([['a.html', '<html><body>A</body></html>']]));
    try {
      const ok = await fetch(`${server.origin}/a.html`);
      expect(ok.status).toBe(200);
      expect(await ok.text()).toContain('A');
      expect((await fetch(`${server.origin}/b.html`)).status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it('cannot be walked out of the corpus, because the path is a map key not a file path', async () => {
    // The request path is only ever used to look up a Map built from the manifest. There is no
    // filesystem join to escape, so traversal is not defended against — it is absent.
    const server = await serveFixtures(new Map([['a.html', 'A']]));
    try {
      for (const p of ['../../../../etc/passwd', '..%2f..%2fpackage.json', '/etc/hosts']) {
        expect((await fetch(`${server.origin}/${p}`)).status).toBe(404);
      }
    } finally {
      await server.close();
    }
  });

  it('binds loopback only, so the corpus is never exposed off-host', async () => {
    const server = await serveFixtures(new Map());
    try {
      expect(server.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    } finally {
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// The live lane
// ---------------------------------------------------------------------------

/**
 * A reader that fetches the served bytes over loopback without a browser.
 *
 * This exercises the lane's PLUMBING — serve, navigate, read back, score — and nothing about
 * rendering. It is deliberately NOT presented as evidence of live-vs-frozen parity: an
 * identity reader would agree with the frozen lane by construction. The real parity number
 * comes from a browser run and is reported separately.
 */
function fetchReader(): LivePageReader {
  let current = '';
  let html = '';
  return {
    goto: async (url: string) => {
      current = url;
      html = await (await fetch(url)).text();
    },
    readCurrentPage: async () => ({ url: current, html }),
    close: async () => {},
  };
}

const miniManifest = (): ScrapeManifest => ({
  version: '1',
  corpusSource: 'test',
  fixtures: [
    {
      id: 'wikipedia-base64',
      url: 'https://en.wikipedia.org/wiki/Base64',
      pageClass: 'reference_tables',
      htmlPath: 'wikipedia-base64.html',
      capturedAt: '2026-08-03',
      licence: 'CC BY-SA 4.0 (Wikipedia)',
      assertions: [
        { kind: 'count', category: 'table_preservation', feature: 'table_row', min: 40, max: 400, why: 'test' },
        { kind: 'contains', category: 'markdown_fidelity', value: 'TWFu', why: 'test' },
      ],
    },
  ],
});

describe('live lane', () => {
  it('renders each fixture through the readCurrentPage seam and scores it', async () => {
    const report = await runLiveLane({ manifest: miniManifest(), htmlDir: HTML_DIR, reader: fetchReader() });
    expect(report.fixtures).toHaveLength(1);
    expect(report.overall.total).toBe(2);
    expect(report.overall.passed).toBe(2);
  }, 60_000);

  it('extracts against the REAL url, not the loopback url, so site rules still apply', async () => {
    const report = await runLiveLane({ manifest: miniManifest(), htmlDir: HTML_DIR, reader: fetchReader() });
    // Loopback is transport for the bytes; it is never the identity of the document. If the
    // lane leaked the 127.0.0.1 url into the extractor, every site-specific extractor would
    // silently stop applying and the live lane would score a different pipeline.
    expect(report.fixtures[0]!.url).toBe('https://en.wikipedia.org/wiki/Base64');
    expect(report.fixtures[0]!.url).not.toMatch(/127\.0\.0\.1/);
  }, 60_000);

  it('hard-errors on a missing snapshot instead of skipping it', async () => {
    const m = miniManifest();
    m.fixtures[0]!.htmlPath = 'never-committed.html';
    await expect(runLiveLane({ manifest: m, htmlDir: HTML_DIR, reader: fetchReader() })).rejects.toThrow(/snapshot missing/);
  });
});

// ---------------------------------------------------------------------------
// Seeded regression — the lane's inversion probe
// ---------------------------------------------------------------------------

describe('seeded regression', () => {
  it('strip_tables genuinely removes tables from a real frozen fixture', () => {
    // Verified against the real megabyte-scale snapshot, not a toy string: the mutation has to
    // survive contact with real markup for the probe below to mean anything.
    const html = readFileSync(join(HTML_DIR, 'wikipedia-base64.html'), 'utf-8');
    const before = (html.match(/<table\b/gi) ?? []).length;
    const after = (applySeed(html, 'strip_tables').match(/<table\b/gi) ?? []).length;
    expect(before).toBeGreaterThan(5);
    expect(after).toBe(0);
  });

  it('leaves the document untouched when no regression is seeded', () => {
    const html = readFileSync(join(HTML_DIR, 'wikipedia-base64.html'), 'utf-8');
    expect(applySeed(html, 'none')).toBe(html);
  });

  it('turns the parity gate RED — the lane can detect a real regression', async () => {
    // THE INVERSION PROBE. The seed removes the CAPABILITY (the tables are not in the DOM the
    // reader hands back), not an artifact of it, so nothing downstream can heal around it.
    const manifest = miniManifest();
    const frozen = await runLiveLane({ manifest, htmlDir: HTML_DIR, reader: fetchReader() });
    const damaged = await runLiveLane({ manifest, htmlDir: HTML_DIR, reader: fetchReader(), seed: 'strip_tables' });
    const parity = compareLanes(manifest, frozen, damaged);
    expect(parity.ok).toBe(false);
    expect(parity.mismatches).toHaveLength(1);
    expect(parity.mismatches[0]).toMatch(/table_row count/);
  }, 120_000);

  it('stays GREEN when nothing is seeded — the gate does not fire on a healthy corpus', async () => {
    // The must-not-fire half. A gate that reddens on a clean run is indistinguishable from one
    // that reddens on a real regression, and gets disabled within a week.
    const manifest = miniManifest();
    const a = await runLiveLane({ manifest, htmlDir: HTML_DIR, reader: fetchReader() });
    const b = await runLiveLane({ manifest, htmlDir: HTML_DIR, reader: fetchReader() });
    const parity = compareLanes(manifest, a, b);
    expect(parity.ok).toBe(true);
    expect(parity.compared).toBe(2);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Parity comparison rules
// ---------------------------------------------------------------------------

describe('compareLanes', () => {
  const manifest: ScrapeManifest = {
    version: '1',
    corpusSource: 'test',
    fixtures: [
      {
        id: 'plain', url: 'https://x/', pageClass: 'reference_tables',
        htmlPath: 'p.html', capturedAt: '2026-08-03', licence: 'n/a',
        assertions: [
          { kind: 'contains', category: 'markdown_fidelity', value: 'a', why: 't' },
          { kind: 'contains', category: 'markdown_fidelity', value: 'b', why: 't' },
        ],
      },
      {
        id: 'hidden', url: 'https://y/', pageClass: 'visibility_divergent',
        htmlPath: 'h.html', capturedAt: '2026-08-03', licence: 'n/a',
        assertions: [{ kind: 'contains', category: 'markdown_fidelity', value: 'c', why: 't' }],
      },
    ],
  };

  const report = (verdicts: Record<string, boolean[]>) =>
    summarise(
      Object.entries(verdicts).map(([id, vs]) => ({
        id,
        url: 'https://x/',
        pageClass: manifest.fixtures.find((f) => f.id === id)!.pageClass,
        extractor: 'defuddle',
        markdownChars: 1,
        ms: 1,
        assertions: vs.map((p, i) => ({ category: 'markdown_fidelity' as const, passed: p, describe: `contains "${'ab c'[i]}"` })),
        categoryScores: {},
      } satisfies FixtureResult)),
      1,
      '2026-08-03T00:00:00.000Z',
    );

  it('excludes visibility_divergent fixtures, which legitimately differ between lanes', () => {
    const frozen = report({ plain: [true, true], hidden: [true] });
    const live = report({ plain: [true, true], hidden: [false] });
    const v = compareLanes(manifest, frozen, live);
    expect(v.ok).toBe(true);
    expect(v.compared).toBe(2);
    expect(v.excluded).toBe(1);
  });

  it('excludes visible_only assertions even on a non-visibility fixture', () => {
    const m: ScrapeManifest = JSON.parse(JSON.stringify(manifest)) as ScrapeManifest;
    m.fixtures[0]!.assertions[1] = { kind: 'visible_only', category: 'boilerplate_noise', value: 'b', why: 't' };
    const frozen = report({ plain: [true, false], hidden: [true] });
    const live = report({ plain: [true, true], hidden: [true] });
    expect(compareLanes(m, frozen, live).ok).toBe(true);
  });

  it('catches two opposite flips that an aggregate-score comparison would call parity', () => {
    // Both lanes score 1/2 here. Comparing aggregates would report "within 0.00" and be wrong:
    // that is not parity, it is two disagreements cancelling.
    const frozen = report({ plain: [true, false], hidden: [true] });
    const live = report({ plain: [false, true], hidden: [true] });
    expect(frozen.overall.score).toBe(live.overall.score);
    const v = compareLanes(manifest, frozen, live);
    expect(v.ok).toBe(false);
    expect(v.mismatches).toHaveLength(2);
  });

  it('reports an assertion the live lane never produced rather than ignoring it', () => {
    const frozen = report({ plain: [true, true], hidden: [true] });
    const live = report({ plain: [true], hidden: [true] });
    const v = compareLanes(manifest, frozen, live);
    expect(v.ok).toBe(false);
    expect(v.mismatches[0]).toMatch(/live=ABSENT/);
  });

  it('excludes exactly one page class, so the gate is not silently widened', () => {
    // virtualized_list also diverges live-vs-frozen, but the spec's exit gate says "the
    // non-visibility classes" and lists the two classes separately. Widening the exclusion
    // here would weaken the gate in the direction nobody audits.
    expect([...VISIBILITY_CLASSES]).toEqual(['visibility_divergent']);
  });
});

// ---------------------------------------------------------------------------
// Corpus gate
// ---------------------------------------------------------------------------

describe('corpus gate', () => {
  const shipped = (): ScrapeManifest =>
    JSON.parse(readFileSync(join(FIXTURES, 'manifest.json'), 'utf-8')) as ScrapeManifest;

  it('publishes 1/N for every bucket, so no threshold can be quoted finer than its corpus', () => {
    const v = validateCorpus(shipped(), HTML_DIR);
    const overall = v.resolution.find((r) => r.bucket === 'overall')!;
    expect(overall.n).toBeGreaterThanOrEqual(CORPUS_TARGETS.assertions);
    for (const r of v.resolution) {
      if (r.n > 0) expect(r.resolution).toBeCloseTo(1 / r.n, 10);
    }
  });

  it('reports the shipped corpus as meeting the §3.2 targets', () => {
    const v = validateCorpus(shipped(), HTML_DIR);
    expect(v.violations).toEqual([]);
    expect(v.fixtures.actual).toBeGreaterThanOrEqual(CORPUS_TARGETS.fixtures);
    expect(v.assertions.actual).toBeGreaterThanOrEqual(CORPUS_TARGETS.assertions);
    expect(v.pageClasses.every((p) => p.ok)).toBe(true);
    expect(v.ok).toBe(true);
  });

  it('still FAILS on a corpus that is short — the gate can fire, not just agree', () => {
    // The negative control, and it is required precisely BECAUSE the shipped corpus now
    // passes. A gate whose only observed verdict is "pass" is indistinguishable from a gate
    // that cannot fail, and the corpus it guards is the thing every S12 threshold is read off.
    const m = shipped();
    m.fixtures = m.fixtures.slice(0, 3);
    const v = validateCorpus(m, HTML_DIR);
    expect(v.ok).toBe(false);
    expect(v.fixtures.ok).toBe(false);
    expect(v.assertions.ok).toBe(false);
  });

  it('FAILS when a required page class is emptied, not just when the totals are short', () => {
    // Class coverage and raw count are independent failure modes. A corpus can hit 20/120 on
    // easy pages while omitting every hard class, which is the exact way a corpus flatters the
    // extractor it is supposed to be refereeing.
    const m = shipped();
    for (const f of m.fixtures) if (f.pageClass === 'chart_hints') f.pageClass = 'reference_prose';
    const v = validateCorpus(m, HTML_DIR);
    expect(v.ok).toBe(false);
    expect(v.pageClasses.find((p) => p.pageClass === 'chart_hints')!.actual).toBe(0);
  });

  it('targets exactly the three reachable classes; virtualized_list is dropped, not weakened', () => {
    // virtualized_list was removed on a measurement: no site JS runs in either lane, so such a
    // fixture would render an empty container in both and the "measured ceiling" would be
    // measuring the absence of a script. Pinned here so it cannot quietly reappear as a
    // requirement nothing can satisfy, nor be replaced by something adjacent.
    expect(Object.keys(CORPUS_TARGETS.pageClasses).sort()).toEqual([
      'chart_hints', 'repeating_rows', 'visibility_divergent',
    ]);
  });

  it('rejects a replay assertion smuggled into the C0 manifest', () => {
    // Unevaluable on the extraction lanes. Left here it would either redden the blocking gate
    // forever or force the scorer to be softened into passing it — and a softened scorer stops
    // being a referee.
    const m = shipped();
    m.fixtures[0]!.assertions.push({ kind: 'row_count', category: 'structured_extract', min: 1, max: 2, why: 't' });
    const v = validateCorpus(m, HTML_DIR);
    expect(v.ok).toBe(false);
    expect(v.violations.join(' ')).toMatch(/belongs to the drift corpus/);
  });

  it('flags a visible_only value that is absent from its own snapshot', () => {
    const m = shipped();
    m.fixtures[0]!.assertions.push({
      kind: 'visible_only', category: 'boilerplate_noise',
      value: 'this string is definitely not in the wikipedia base64 article', why: 't',
    });
    const v = validateCorpus(m, HTML_DIR);
    expect(v.violations.join(' ')).toMatch(/suppresses nothing/);
  });

  it('does not flag a visible_only value that IS present in its snapshot', () => {
    // The must-not-fire half of the vacuity check: a real hidden string must pass validation,
    // or authors learn the check is noise and route around it.
    const m = shipped();
    m.fixtures[0]!.assertions.push({
      kind: 'visible_only', category: 'boilerplate_noise', value: 'Base64', why: 't',
    });
    const v = validateCorpus(m, HTML_DIR);
    expect(v.violations.join(' ')).not.toMatch(/suppresses nothing/);
  });
});

// ---------------------------------------------------------------------------
// Drift corpus
// ---------------------------------------------------------------------------

describe('mutation engine', () => {
  const real = () => readFileSync(join(HTML_DIR, 'wikipedia-base64.html'), 'utf-8');

  it.each(MUTATION_CLASSES)('%s changes a real frozen fixture', (m) => {
    // Run against the real snapshot, not a literal: a mutation that only works on hand-written
    // markup would produce a drift corpus of shapes nobody's page actually has.
    const html = real();
    expect(mutate(html, m)).not.toBe(html);
  });

  it('class_rename rewrites every class token, defeating a name-based fingerprint', () => {
    const out = mutate('<div class="a b"><p class="c">x</p></div>', 'class_rename', 7);
    expect(out).toBe('<div class="a-r7 b-r7"><p class="c-r7">x</p></div>');
  });

  it('wrapper_div adds exactly one level above the content, not around each node', () => {
    const out = mutate('<html><body><p>x</p></body></html>', 'wrapper_div', 3);
    expect(out).toBe('<html><body><div class="wg-drift-wrap-3"><p>x</p></div></body></html>');
  });

  it('sibling_reorder reverses row order while preserving every row', () => {
    const out = mutate('<tbody><tr><td>1</td></tr><tr><td>2</td></tr><tr><td>3</td></tr></tbody>', 'sibling_reorder');
    expect(out).toBe('<tbody><tr><td>3</td></tr><tr><td>2</td></tr><tr><td>1</td></tr></tbody>');
  });

  it('sibling_reorder leaves a single-row table alone rather than claiming a mutation', () => {
    const one = '<tbody><tr><td>1</td></tr></tbody>';
    expect(mutate(one, 'sibling_reorder')).toBe(one);
  });

  it('attribute_churn regenerates data-* values but keeps the attribute names', () => {
    const out = mutate('<div data-testid="rows" data-v="1">x</div>', 'attribute_churn');
    expect(out).toMatch(/data-testid="wg1/);
    expect(out).not.toMatch(/"rows"/);
  });

  it('section_rewrap replaces semantic containers with generic ones', () => {
    const out = mutate('<main><section><p>x</p></section></main>', 'section_rewrap');
    expect(out).toBe('<div data-was="main"><div data-was="section"><p>x</p></div></div>');
  });
});

describe('drift corpus gate', () => {
  const shippedDrift = (): DriftManifest =>
    JSON.parse(readFileSync(join(FIXTURES, 'recipes', 'manifest.json'), 'utf-8')) as DriftManifest;

  it('reports the scaffold as unpopulated, with the shortfall in numbers', () => {
    const v = validateDriftCorpus(shippedDrift());
    expect(v.ok).toBe(false);
    expect(v.recipes.actual).toBe(0);
    expect(v.cases.actual).toBe(0);
    expect(v.cases.required).toBe(60);
  });

  it('states that the silent-wrong gate is NOT expressible on an empty corpus', () => {
    // §8-B's <=0.02 collapses to "exactly zero" below ~50 cases. The spec requires that be
    // flagged rather than absorbed, because a threshold finer than its corpus reads like a
    // tolerance and means zero.
    expect(validateDriftCorpus(shippedDrift()).silentWrongExpressible).toBe(false);
  });

  it('becomes expressible at 50 cases and reports what <=0.02 then means', () => {
    const m: DriftManifest = { version: '1', note: 't', recipes: [] };
    for (let i = 0; i < 15; i += 1) {
      m.recipes.push({
        id: `r${i}`, fixtureId: 'wikipedia-base64', columns: ['a'], healTierAtRecord: 'high',
        variants: MUTATION_CLASSES.slice(0, 4).map((mutation, j) => ({
          mutation,
          expected: j === 0 ? { outcome: 'refuse' } : { outcome: 'resolve', atTier: 'high' },
          assertions: [],
        })),
      });
    }
    const v = validateDriftCorpus(m);
    expect(v.cases.actual).toBe(60);
    expect(v.silentWrongExpressible).toBe(true);
    expect(v.ok).toBe(true);
  });

  it('rejects a corpus with no must-REFUSE variant, which cannot detect over-firing', () => {
    // A resolver that never refuses scores perfectly on an all-resolve corpus. Over-firing is
    // the silent-wrong failure §8-B is built to catch, so a corpus blind to it is not a corpus.
    const m: DriftManifest = {
      version: '1', note: 't',
      recipes: [{
        id: 'r0', fixtureId: 'f', columns: ['a'], healTierAtRecord: 'high',
        variants: MUTATION_CLASSES.slice(0, 4).map((mutation) => ({
          mutation, expected: { outcome: 'resolve', atTier: 'high' } as const, assertions: [],
        })),
      }],
    };
    expect(validateDriftCorpus(m).violations.join(' ')).toMatch(/no must-REFUSE variant/);
  });

  it('rejects a recipe whose variants repeat a mutation class', () => {
    const m: DriftManifest = {
      version: '1', note: 't',
      recipes: [{
        id: 'r0', fixtureId: 'f', columns: ['a'], healTierAtRecord: 'high',
        variants: [
          { mutation: 'class_rename', expected: { outcome: 'refuse' }, assertions: [] },
          { mutation: 'class_rename', expected: { outcome: 'resolve', atTier: 'high' }, assertions: [] },
        ],
      }],
    };
    expect(validateDriftCorpus(m).violations.join(' ')).toMatch(/mutation classes repeat/);
  });

  it('flags a recipe carrying fewer than four variants', () => {
    const m: DriftManifest = {
      version: '1', note: 't',
      recipes: [{
        id: 'thin', fixtureId: 'f', columns: ['a'], healTierAtRecord: 'medium',
        variants: [{ mutation: 'class_rename', expected: { outcome: 'refuse' }, assertions: [] }],
      }],
    };
    expect(validateDriftCorpus(m).underVariedRecipes[0]).toMatch(/thin: 1 variant/);
  });
});
