import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  countFeature,
  evaluateAssertion,
  compareToBaseline,
  summarise,
  assertionKey,
} from '../../../benchmarks/scrape-quality/score.js';
import { runBenchmark, runFixture, loadManifest } from '../../../benchmarks/scrape-quality/runner.js';
import type { Assertion, FixtureResult, ScrapeManifest } from '../../../benchmarks/scrape-quality/types.js';
import type { StructuredData } from '../../../src/types.js';

const EMPTY_STRUCTURED: StructuredData = {
  tables: [], definitions: [], jsonld: [], chart_hints: [], key_value_pairs: [],
};

describe('countFeature', () => {
  it('counts table rows without counting the |---| separator rule', () => {
    // The separator is what a flattened table leaves behind; counting it would let a
    // table collapse to a header stub and still score as "table preserved".
    const md = ['| a | b |', '| --- | --- |', '| 1 | 2 |', '| 3 | 4 |'].join('\n');
    expect(countFeature(md, 'table_row')).toBe(3);
  });

  it('counts fenced code blocks in pairs, so an unterminated fence is not a block', () => {
    expect(countFeature('```ts\nx\n```\ntext\n```js\ny\n```', 'code_block')).toBe(2);
    expect(countFeature('```ts\nx', 'code_block')).toBe(0);
  });

  it('does not count a # inside prose as a heading', () => {
    expect(countFeature('issue #42 was fixed\n# Real Heading', 'heading')).toBe(1);
  });
});

describe('evaluateAssertion', () => {
  const contains = (value: string): Assertion => ({ kind: 'contains', category: 'markdown_fidelity', value, why: 'test' });

  it('tolerates whitespace reflow and markdown escaping', () => {
    // Extractors legitimately reflow whitespace and escape punctuation. Treating either
    // as a regression would make the gate fire on cosmetic, correct changes — the fastest
    // way to get a blocking check disabled.
    const md = 'The  cost is  \\$5\\.00\nper unit';
    expect(evaluateAssertion(contains('cost is $5.00 per unit'), md, EMPTY_STRUCTURED).passed).toBe(true);
  });

  it('fails when the claimed content is genuinely absent', () => {
    expect(evaluateAssertion(contains('nonexistent phrase'), 'some other text', EMPTY_STRUCTURED).passed).toBe(false);
  });

  it('flags boilerplate that leaked into the output', () => {
    const a: Assertion = { kind: 'absent', category: 'boilerplate_noise', value: 'Accept all cookies', why: 'test' };
    expect(evaluateAssertion(a, 'Intro\nAccept all cookies\nBody', EMPTY_STRUCTURED).passed).toBe(false);
    expect(evaluateAssertion(a, 'Intro\nBody', EMPTY_STRUCTURED).passed).toBe(true);
  });

  it('reads table cells out of structured rows, which are keyed objects not arrays', () => {
    const structured: StructuredData = {
      ...EMPTY_STRUCTURED,
      tables: [{ headers: ['Element', 'Symbol'], rows: [{ Element: 'Hydrogen', Symbol: 'H' }] }],
    };
    const a: Assertion = { kind: 'table_cell', category: 'table_preservation', value: 'Hydrogen', why: 'test' };
    expect(evaluateAssertion(a, '', structured).passed).toBe(true);
  });

  it('reports the actual number when a count assertion fails, so the report is diagnosable', () => {
    const a: Assertion = { kind: 'count', category: 'markdown_fidelity', feature: 'heading', min: 5, max: 10, why: 'test' };
    const r = evaluateAssertion(a, '# one', EMPTY_STRUCTURED);
    expect(r.passed).toBe(false);
    expect(r.detail).toBe('actual 1');
  });
});

describe('compareToBaseline — the PR gate rule', () => {
  const report = (verdicts: boolean[]) =>
    summarise(
      [{
        id: 'f1', url: 'https://x/', pageClass: 'article', extractor: 'defuddle',
        markdownChars: 10, ms: 1,
        assertions: verdicts.map((p, i) => ({ category: 'markdown_fidelity' as const, passed: p, describe: `a${i}` })),
        categoryScores: {},
      } satisfies FixtureResult],
      1,
      '2026-08-03T00:00:00.000Z',
    );

  it('fails only on a was-passing assertion that now fails', () => {
    const base = { [assertionKey('f1', 0, 'a0')]: true, [assertionKey('f1', 1, 'a1')]: true };
    const v = compareToBaseline(report([true, false]), base);
    expect(v.ok).toBe(false);
    expect(v.regressions).toEqual([assertionKey('f1', 1, 'a1')]);
  });

  it('does not fail when a previously-failing assertion starts passing', () => {
    const base = { [assertionKey('f1', 0, 'a0')]: false };
    const v = compareToBaseline(report([true]), base);
    expect(v.ok).toBe(true);
    expect(v.improvements).toHaveLength(1);
  });

  it('does not fail on assertions added since the baseline, even when they fail', () => {
    // Tightening the corpus must not require re-baselining in the same PR, or authors
    // learn to re-baseline reflexively and the gate stops meaning anything.
    const base = { [assertionKey('f1', 0, 'a0')]: true };
    const v = compareToBaseline(report([true, false]), base);
    expect(v.ok).toBe(true);
    expect(v.newAssertions).toEqual([assertionKey('f1', 1, 'a1')]);
  });

  it('reports assertions dropped since the baseline instead of ignoring them', () => {
    const base = { [assertionKey('f1', 0, 'a0')]: true, [assertionKey('f1', 9, 'gone')]: true };
    const v = compareToBaseline(report([true]), base);
    expect(v.missingAssertions).toEqual([assertionKey('f1', 9, 'gone')]);
  });
});

describe('runner', () => {
  it('scores every assertion as failed when extraction throws, never as absent', () => {
    // A crash that removed assertions from the denominator would score 100%.
    const fixture: ScrapeManifest['fixtures'][number] = {
      id: 'boom', url: 'not a url at all', pageClass: 'article',
      htmlPath: 'x.html', capturedAt: '2026-08-03', licence: 'n/a',
      assertions: [
        { kind: 'contains', category: 'markdown_fidelity', value: 'anything', why: 'test' },
        { kind: 'contains', category: 'markdown_fidelity', value: 'another', why: 'test' },
      ],
    };
    return runFixture(fixture, '<html><body><p>hi</p></body></html>').then((r) => {
      // Either it extracted (assertions genuinely evaluated) or it threw — in both cases
      // the assertion count must be preserved.
      expect(r.assertions).toHaveLength(2);
    });
  });

  it('throws on a manifest entry whose snapshot is missing, rather than skipping it', async () => {
    // This is exactly how the old extraction corpus rotted: 21 manifest entries pointing
    // at HTML files that were never committed, silently producing an empty run.
    const dir = mkdtempSync(join(tmpdir(), 'sq-'));
    try {
      const manifestPath = join(dir, 'manifest.json');
      const manifest: ScrapeManifest = {
        version: '1', corpusSource: 'test',
        fixtures: [{
          id: 'ghost', url: 'https://x/', pageClass: 'article',
          htmlPath: 'never-committed.html', capturedAt: '2026-08-03', licence: 'n/a',
          assertions: [{ kind: 'contains', category: 'markdown_fidelity', value: 'x', why: 'test' }],
        }],
      };
      writeFileSync(manifestPath, JSON.stringify(manifest));
      await expect(runBenchmark({ manifestPath, htmlDir: dir })).rejects.toThrow(/snapshot missing/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects an empty manifest instead of reporting a perfect empty run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sq-'));
    try {
      const p = join(dir, 'manifest.json');
      writeFileSync(p, JSON.stringify({ version: '1', corpusSource: 't', fixtures: [] }));
      expect(() => loadManifest(p)).toThrow(/no fixtures/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
