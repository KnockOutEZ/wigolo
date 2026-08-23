import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateAssertion } from '../../benchmarks/scrape-quality/score.js';
import { loadManifest } from '../../benchmarks/scrape-quality/runner.js';
import { extractContent } from '../../src/extraction/pipeline.js';
import type { Assertion } from '../../benchmarks/scrape-quality/types.js';
import type { StructuredData } from '../../src/types.js';

/**
 * K25 — `visible_only` scores OCCURRENCES, not substring presence.
 *
 * This lives at the integration seam on purpose: the referee's notion of "visible" is
 * `stripHiddenDom` from the extraction pipeline, and the property being scored is a
 * relation between what the real extractor emits and what the real source shows. A test
 * that mocked either side could only agree with itself. The corpus cases below therefore
 * run the actual extractor over the actual frozen fixtures.
 */

const here = dirname(fileURLToPath(import.meta.url));
const HTML_DIR = join(here, '..', '..', 'benchmarks', 'scrape-quality', 'fixtures', 'html');

const EMPTY_STRUCTURED: StructuredData = {
  tables: [], definitions: [], jsonld: [], chart_hints: [], key_value_pairs: [],
};

const VALUE = 'General-purpose programming language';

const assertion = (value: string): Assertion => ({
  kind: 'visible_only', category: 'boilerplate_noise', value, why: 'test',
});

/** wikipedia-python's shape in miniature: the hidden string has a VISIBLE twin — anchor
 *  text and title attribute — so a correct extractor emits the string twice and cannot
 *  emit it zero times without deleting text a human reads. */
const TWINNED = [
  '<html><body>',
  `<div class="shortdescription" style="display:none">${VALUE}</div>`,
  `<p>Python is a <a href="/wiki/General-purpose_programming_language" title="${VALUE}">general-purpose programming language</a>.</p>`,
  '</body></html>',
].join('');

/** What a faithful extractor emits from TWINNED: the visible link, serialised with its
 *  title — two copies, neither of them the hidden div. */
const FAITHFUL_MD = `Python is a [general-purpose programming language](https://en.wikipedia.org/wiki/General-purpose_programming_language "${VALUE}").`;

describe('visible_only — occurrence scoring (K25)', () => {
  it('MUST NOT FIRE on a faithful extraction of a page whose hidden string has a visible twin', () => {
    const r = evaluateAssertion(assertion(VALUE), FAITHFUL_MD, EMPTY_STRUCTURED, { sourceHtml: TWINNED });
    expect(r.passed).toBe(true);
    expect(r.detail).toBeUndefined();
  });

  it('and the old presence rule WOULD have fired on it — this case is not vacuously green', () => {
    // The guard against a relaxation that passes because there is nothing left to score.
    // The markdown genuinely contains the value; only counting distinguishes the two.
    expect(FAITHFUL_MD.toLowerCase()).toContain(VALUE.toLowerCase());
  });

  it('OVER-FIRE PROBE: one extra copy — the hidden div leaking — still FAILS', () => {
    const leaked = `${VALUE}\n\n${FAITHFUL_MD}`;
    const r = evaluateAssertion(assertion(VALUE), leaked, EMPTY_STRUCTURED, { sourceHtml: TWINNED });
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/leaked/);
    expect(r.detail).toMatch(/3 occurrence\(s\) in markdown vs 2 visible/);
  });

  it('still catches a hidden-only leak, the case the arm has always existed for', () => {
    const html = '<html><body><div hidden>You signed out in another tab</div><p>Shown</p></body></html>';
    const a = assertion('You signed out in another tab');
    expect(evaluateAssertion(a, 'Shown', EMPTY_STRUCTURED, { sourceHtml: html }).passed).toBe(true);
    const leaked = evaluateAssertion(a, 'Shown\nYou signed out in another tab', EMPTY_STRUCTURED, { sourceHtml: html });
    expect(leaked.passed).toBe(false);
    expect(leaked.detail).toMatch(/1 occurrence\(s\) in markdown vs 0 visible/);
  });

  it('FAILS as VACUOUS when every source occurrence is visible', () => {
    // Stricter than the old presence-in-source precondition, and the reason the relaxation
    // is safe: an assertion whose value is only ever visible suppresses nothing, so it can
    // never fail for the reason it exists. It must say so rather than score a free point.
    const visibleOnly = `<html><body><p>${VALUE}</p></body></html>`;
    const r = evaluateAssertion(assertion(VALUE), 'nothing', EMPTY_STRUCTURED, { sourceHtml: visibleOnly });
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/VACUOUS: all 1 source occurrence\(s\) are visible/);
  });

  it('FAILS as VACUOUS when the value is nowhere in the source, as a typo would be', () => {
    const r = evaluateAssertion(assertion('Never on this page'), 'nothing', EMPTY_STRUCTURED, {
      sourceHtml: '<html><body><p>Shown</p></body></html>',
    });
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/VACUOUS: value is not in the source HTML/);
  });

  it('does not count <script> text as visible, so JSON-LD cannot pay for a leaked copy', () => {
    // wikipedia-covid19's shape. Its hidden string also sits in a JSON-LD body, which is
    // never rendered. Counting that as visible would buy one leaked copy of the hidden div
    // and the row would pass for a reason unrelated to visibility.
    const html = [
      '<html><body>',
      '<div class="shortdescription" style="display:none">Contagious disease</div>',
      '<script type="application/ld+json">{"description":"Contagious disease"}</script>',
      '<p>Shown</p></body></html>',
    ].join('');
    const a = assertion('Contagious disease');
    expect(evaluateAssertion(a, 'Shown', EMPTY_STRUCTURED, { sourceHtml: html }).passed).toBe(true);
    const leaked = evaluateAssertion(a, 'Shown\nContagious disease', EMPTY_STRUCTURED, { sourceHtml: html });
    expect(leaked.passed).toBe(false);
    expect(leaked.detail).toMatch(/1 occurrence\(s\) in markdown vs 0 visible/);
  });

  it('counts title/alt on visible elements, which a serialiser legitimately carries through', () => {
    // Without these, `[text](href "title")` — one visible element, two copies in the
    // markdown — would read as a leak and no extractor could clear it.
    const html = `<html><body><div hidden>${VALUE}</div><p><img src="x.png" alt="${VALUE}"></p></body></html>`;
    const r = evaluateAssertion(assertion(VALUE), `![${VALUE}](x.png)`, EMPTY_STRUCTURED, { sourceHtml: html });
    expect(r.passed).toBe(true);
  });
});

describe('visible_only — against the frozen corpus', () => {
  const manifest = loadManifest();
  const cases = manifest.fixtures.flatMap((f) =>
    f.assertions
      .filter((a): a is Extract<Assertion, { kind: 'visible_only' }> => a.kind === 'visible_only')
      .map((a) => ({ id: f.id, url: f.url, htmlPath: f.htmlPath, a })),
  );

  it('the corpus still has visible_only coverage to score', () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const c of cases) {
    it(`${c.id} passes, and one injected copy makes it fail`, async () => {
      const html = readFileSync(join(HTML_DIR, c.htmlPath), 'utf-8');
      const markdown = (await extractContent(html, c.url)).markdown;
      const ctx = { sourceHtml: html };

      const real = evaluateAssertion(c.a, markdown, EMPTY_STRUCTURED, ctx);
      expect(real.passed, `${c.id}: ${real.detail ?? ''}`).toBe(true);

      // OVER-FIRE PROBE, per fixture: a relaxation that stops catching the real leak is
      // worse than the bug it fixed. One more copy than the visible source can account for
      // has exactly one possible supplier — a hidden node — and must still be caught.
      const leaked = evaluateAssertion(c.a, `${markdown}\n\n${c.a.value}`, EMPTY_STRUCTURED, ctx);
      expect(leaked.passed, `${c.id} did not catch an injected copy`).toBe(false);
      expect(leaked.detail).toMatch(/leaked/);
    }, 60_000);
  }
});
