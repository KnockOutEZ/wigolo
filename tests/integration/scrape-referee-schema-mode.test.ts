import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateAssertion, assertionKey } from '../../benchmarks/scrape-quality/score.js';
import { loadFrozenAssertions, loadManifest, runFixture, schemaFixtureIds } from '../../benchmarks/scrape-quality/runner.js';
import { extractWithSchemaDetailed } from '../../src/extraction/schema.js';
import type { Assertion, Baseline, SchemaProbe } from '../../benchmarks/scrape-quality/types.js';
import type { StructuredData } from '../../src/types.js';

/**
 * SD9-Q1 — the schema-mode rows of the scrape-quality referee corpus.
 *
 * Two obligations, and they are different obligations:
 *
 *  1. The frozen snapshot still reproduces. `benchmarks/scrape-quality/baseline-schema.json`
 *     is what makes "no regression vs the SD0 baseline" evaluable for schema mode, and a
 *     frozen artifact nothing re-runs is a number, not a gate. The bench CLI re-runs it; this
 *     puts the same claim inside `npm test`, where a change to `src/extraction/schema.ts`
 *     actually gets noticed.
 *
 *  2. The rows can FAIL. A corpus that reads 25/25 is worth exactly as much as its ability to
 *     go red, and every one of these kinds is new. The second block drives each of them
 *     through the failure it exists to catch, and through the vacuity refusals that stop a row
 *     scoring a free point forever.
 */

const here = dirname(fileURLToPath(import.meta.url));
const BENCH = join(here, '..', '..', 'benchmarks', 'scrape-quality');
const HTML_DIR = join(BENCH, 'fixtures', 'html');

const EMPTY_STRUCTURED: StructuredData = {
  tables: [], definitions: [], jsonld: [], chart_hints: [], key_value_pairs: [],
};

const schemaBaseline = JSON.parse(readFileSync(join(BENCH, 'baseline-schema.json'), 'utf-8')) as Baseline;
const manifest = loadManifest();
const schemaFixtures = manifest.fixtures.filter((f) => schemaFixtureIds(manifest).has(f.id));

describe('schema-mode referee rows — the frozen snapshot reproduces', () => {
  it('has fixtures at all, and every one of them declares a schema', () => {
    // The guard against this whole file passing over an empty set: a manifest edit that
    // dropped the schema fixtures would otherwise make every loop below iterate zero times.
    expect(schemaFixtures.length).toBeGreaterThanOrEqual(5);
    for (const f of schemaFixtures) expect(f.schema?.properties).toBeTruthy();
  });

  it('reproduces every verdict in baseline-schema.json, key for key', async () => {
    const seen: Record<string, boolean> = {};
    for (const f of schemaFixtures) {
      const html = readFileSync(join(HTML_DIR, f.htmlPath), 'utf-8');
      const result = await runFixture(f, html);
      expect(result.error).toBeUndefined();
      result.assertions.forEach((a, i) => { seen[assertionKey(f.id, i, a.describe)] = a.passed; });
    }
    // Both directions. Equal maps, not "every baseline key still passes" — a renamed or
    // deleted row would satisfy the one-way version by disappearing.
    expect(Object.keys(seen).sort()).toEqual(Object.keys(schemaBaseline.assertions).sort());
    expect(seen).toEqual(schemaBaseline.assertions);
  }, 120_000);

  it('is read by the gate: every frozen schema key is in the merged baseline map', () => {
    // The acceptance criterion, checked rather than asserted in prose. `compareToBaseline`
    // never punishes an assertion it has no baseline entry for, so a schema row missing from
    // the merged map is reported as "new" and gated on by nothing.
    const merged = loadFrozenAssertions();
    for (const k of Object.keys(schemaBaseline.assertions)) expect(merged).toHaveProperty([k]);
  });

  it('refuses to merge two baselines that disagree about the same key', () => {
    // The collision arm of the merge. Two files covering disjoint fixtures cannot collide
    // today; "cannot happen" is how a frozen number gets quietly replaced tomorrow.
    const key = Object.keys(schemaBaseline.assertions)[0]!;
    const dir = mkdtempSync(join(tmpdir(), 'sd437-'));
    const one = join(dir, 'a.json');
    const two = join(dir, 'b.json');
    writeFileSync(one, JSON.stringify({ ...schemaBaseline, assertions: { [key]: true } }));
    writeFileSync(two, JSON.stringify({ ...schemaBaseline, assertions: { [key]: false } }));
    expect(() => loadFrozenAssertions(one, two)).toThrow(/baseline collision/);
    // Agreeing on the same key is not a collision, and an absent file is skipped rather than
    // treated as an empty baseline that silently drops every frozen row.
    writeFileSync(two, JSON.stringify({ ...schemaBaseline, assertions: { [key]: true } }));
    expect(Object.keys(loadFrozenAssertions(one, two))).toEqual([key]);
    expect(loadFrozenAssertions(one, join(dir, 'missing.json'))).toEqual({ [key]: true });
    rmSync(dir, { recursive: true, force: true });
  });
});

/* ------------------------------------------------------------------ can these rows fail? */

const probe = (declared: Record<string, unknown>, values: Record<string, unknown>, provenance: Record<string, string> = {}): SchemaProbe =>
  ({
    declared: { type: 'object', properties: declared as never },
    result: { values, provenance: provenance as never },
  });

const run = (a: Assertion, p?: SchemaProbe) => evaluateAssertion(a, '', EMPTY_STRUCTURED, { schema: p });

describe('schema-mode rows go red when schema mode breaks', () => {
  it('schema_value fires when the field stops being populated', () => {
    const a: Assertion = { kind: 'schema_value', category: 'schema_extract', field: 'name', value: 'got', exact: true, why: 't' };
    expect(run(a, probe({ name: {} }, { name: 'got' })).passed).toBe(true);
    const dead = run(a, probe({ name: {} }, {}));
    expect(dead.passed).toBe(false);
    expect(dead.detail).toContain('unpopulated');
  });

  it('schema_value exact rejects a value containment would have accepted', () => {
    // Why `exact` exists: "got" is three letters, and a field that collapsed to a run of body
    // text would contain it. Containment alone would call that a pass.
    const drifted = probe({ name: {} }, { name: 'forgot to publish' });
    expect(run({ kind: 'schema_value', category: 'schema_extract', field: 'name', value: 'got', exact: true, why: 't' }, drifted).passed).toBe(false);
    expect(run({ kind: 'schema_value', category: 'schema_extract', field: 'name', value: 'got', why: 't' }, drifted).passed).toBe(true);
  });

  it('schema_provenance fires when the value survives but its source degrades', () => {
    // The regression this kind exists for: identical text, arrived through the fuzzy limb
    // instead of the page's declared JSON-LD. Nothing else in the corpus can see it.
    const a: Assertion = { kind: 'schema_provenance', category: 'schema_extract', field: 'headline', expect: ['json-ld'], why: 't' };
    const values = { headline: 'Global Temperature' };
    expect(run(a, probe({ headline: {} }, values, { headline: 'json-ld' })).passed).toBe(true);
    const degraded = run(a, probe({ headline: {} }, values, { headline: 'structured' }));
    expect(degraded.passed).toBe(false);
    expect(degraded.detail).toBe('actual structured');
  });

  it('schema_rows fires when a grid stops resolving to an array', () => {
    const a: Assertion = { kind: 'schema_rows', category: 'schema_extract', field: 'browsers', min: 150, why: 't' };
    expect(run(a, probe({ browsers: {} }, { browsers: new Array(206).fill({}) })).passed).toBe(true);
    expect(run(a, probe({ browsers: {} }, { browsers: new Array(12).fill({}) })).passed).toBe(false);
    expect(run(a, probe({ browsers: {} }, { browsers: 'Chrome, Firefox' })).detail).toContain('did not resolve to an array');
  });

  it('schema_row_field fires on a grid that keeps its rows and loses its join key', () => {
    // The property row COUNT cannot see. 206 rows with the key filled on 12 of them reports a
    // healthy count and joins nothing across tabs.
    const rows = new Array(206).fill(null).map((_, i) => (i < 12 ? { browser: 'Amaya' } : { browser: '' }));
    const p = probe({ browsers: {} }, { browsers: rows });
    expect(run({ kind: 'schema_rows', category: 'schema_extract', field: 'browsers', min: 150, why: 't' }, p).passed).toBe(true);
    const thin = run({ kind: 'schema_row_field', category: 'schema_extract', field: 'browsers', column: 'browser', minFilled: 150, why: 't' }, p);
    expect(thin.passed).toBe(false);
    expect(thin.detail).toBe('actual 12 of 206');
  });

  it('schema_absent fires when the fuzzy limb invents a value the page never carried', () => {
    const a: Assertion = { kind: 'schema_absent', category: 'schema_extract', field: 'licence_holder', why: 't' };
    const honest = probe({ name: {}, licence_holder: {} }, { name: 'got' }, { name: 'microdata' });
    expect(run(a, honest).passed).toBe(true);
    const invented = probe({ name: {}, licence_holder: {} }, { name: 'got', licence_holder: 'package.json' }, { name: 'microdata', licence_holder: 'structured' });
    const r = run(a, invented);
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('INVENTED');
  });
});

describe('schema-mode rows refuse to score when they would be measuring nothing', () => {
  it('a row with no probe is unevaluated, never satisfied', () => {
    const r = run({ kind: 'schema_rows', category: 'schema_extract', field: 'browsers', min: 1, why: 't' });
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('need a schema-mode probe');
  });

  it('a row naming a field the fixture never declared is VACUOUS', () => {
    // The free-pass shape: nothing asked for the field, so neither its value nor its absence
    // means anything, and for `schema_absent` it would pass for the life of the corpus.
    for (const a of [
      { kind: 'schema_value', category: 'schema_extract', field: 'typo', value: 'x', why: 't' },
      { kind: 'schema_absent', category: 'schema_extract', field: 'typo', why: 't' },
      { kind: 'schema_provenance', category: 'schema_extract', field: 'typo', expect: ['json-ld'], why: 't' },
    ] as Assertion[]) {
      const r = run(a, probe({ name: {} }, { name: 'got' }, { name: 'microdata' }));
      expect(r.passed).toBe(false);
      expect(r.detail).toContain('VACUOUS');
    }
  });

  it('schema_absent is VACUOUS when schema mode answered nothing at all', () => {
    // Without this, a dead extractor makes every negative row green: it populates nothing, so
    // "this field stayed empty" is true for exactly the wrong reason.
    const r = run({ kind: 'schema_absent', category: 'schema_extract', field: 'licence_holder', why: 't' }, probe({ name: {}, licence_holder: {} }, {}));
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('schema mode answered nothing');
  });

  it('and the corpus really does own that case: its negative rows sit beside populated siblings', async () => {
    // The above is a constructed probe. This checks the claim where it has to hold — on the
    // real fixtures, through the real extractor — so the guard cannot be green because no
    // corpus row exercises it.
    const negatives = schemaFixtures.filter((f) => f.assertions.some((a) => a.kind === 'schema_absent'));
    expect(negatives.length).toBeGreaterThanOrEqual(3);
    for (const f of negatives) {
      const html = readFileSync(join(HTML_DIR, f.htmlPath), 'utf-8');
      const result = extractWithSchemaDetailed(html, f.schema!);
      const absent = f.assertions.filter((a) => a.kind === 'schema_absent').map((a) => (a as { field: string }).field);
      const siblings = Object.keys(f.schema!.properties ?? {}).filter((k) => !absent.includes(k));
      expect(siblings.some((k) => result.values[k] !== undefined)).toBe(true);
      for (const k of absent) expect(result.values[k]).toBeUndefined();
    }
  }, 60_000);
});
