import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assessListTitleAttrition } from '../../../src/extraction/completeness.js';
import { routedExtract } from '../../../src/extraction/v1/routed.js';

const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, '../../fixtures/extraction', name), 'utf-8');

const githubIssueList = fixture('github-issue-list-real.html');

// Each row gets its OWN vocabulary. Rows sharing title words would mask each
// other under token-set matching — a surviving title would make its vanished
// neighbours look present too — so distinct words are what let a ratio test
// mean anything at all.
const TITLE_WORDS = [
  'hydration mismatch dialog',
  'compiler recursion memo',
  'devtools node removal',
  'suspense boundary flush',
  'transition scheduler starvation',
  'portal cleanup ordering',
  'refs forwarded incorrectly',
  'context propagation stall',
  'concurrent tearing observed',
  'effects fired twice',
  'reconciler keyed churn',
  'profiler timings skewed',
];

const titleFor = (i: number) => `Bug ${TITLE_WORDS[i % TITLE_WORDS.length]} case ${i}`;
const residueFor = (i: number) => `Status: Open. #${1000 + i} filed by contributor${i}`;

/** A list of `count` rows, each with a heading and a metadata residue line. */
const listPage = (count: number) => {
  const rows = Array.from(
    { length: count },
    (_, i) => `<li><h3><a href="/item/${i}">${titleFor(i)}</a></h3><p>${residueFor(i)}</p></li>`,
  ).join('');
  return `<html><head><title>Listing</title></head><body><main><ul role="list">${rows}</ul></main></body></html>`;
};

/** Markdown that keeps every row bullet AND every heading. */
const completeMarkdown = (count: number, from = 0) =>
  Array.from(
    { length: count },
    (_, i) => `*   ### ${titleFor(from + i)}\n\n    ${residueFor(from + i)}\n`,
  ).join('\n');

/** Markdown that keeps every row bullet but DROPS every heading. */
const titlelessMarkdown = (count: number, from = 0) =>
  Array.from({ length: count }, (_, i) => `*   ${residueFor(from + i)}\n`).join('\n');

describe('assessListTitleAttrition — the silent partial shell predicate', () => {
  // The whole point of the signal: the caller cannot tell from the output that
  // content is missing, because the row structure survived intact. Firing here
  // is what turns a silently-corrupt result into an actionable one.
  it('fires when the row structure survives but the titles do not', () => {
    const verdict = assessListTitleAttrition(listPage(12), titlelessMarkdown(12));
    expect(verdict).toEqual({
      level: 'partial',
      reason: 'list_titles_dropped',
      settled_by: 'extraction',
    });
  });

  // NEGATIVE. A detector that fires on complete output teaches callers to
  // ignore it, which is worse than having no detector at all.
  it('stays silent when every title survives', () => {
    expect(assessListTitleAttrition(listPage(12), completeMarkdown(12))).toBeUndefined();
  });

  // NEGATIVE. A list dropped WHOLESALE (related-links block, nav rail) is a
  // correct extraction decision, not attrition — there is no residue pretending
  // the rows are still there, so the output does not mislead anyone.
  it('stays silent when the list is dropped wholesale, leaving no residue', () => {
    const md = '# Article\n\nA paragraph of genuine prose that stands alone as the content.';
    expect(assessListTitleAttrition(listPage(12), md)).toBeUndefined();
  });

  // NEGATIVE. Rows that never had a heading cannot have lost one. This is the
  // class a naive "few titles" heuristic would wreck.
  it('stays silent on a list whose rows never had headings', () => {
    const rows = Array.from(
      { length: 12 },
      (_, i) => `<li><a href="/x/${i}">plain link ${i}</a></li>`,
    ).join('');
    const html = `<html><body><main><ul>${rows}</ul></main></body></html>`;
    const md = Array.from({ length: 12 }, (_, i) => `*   [plain link ${i}](/x/${i})`).join('\n');
    expect(assessListTitleAttrition(html, md)).toBeUndefined();
  });

  // NEGATIVE — the short-but-complete stub. Below the N floor the ratio has no
  // resolution, so the gate must refuse to judge rather than guess.
  it('stays silent below the 5-row floor even when every title is gone', () => {
    expect(assessListTitleAttrition(listPage(4), titlelessMarkdown(4))).toBeUndefined();
  });

  it('fires at exactly the 5-row floor when the titles are gone', () => {
    expect(assessListTitleAttrition(listPage(5), titlelessMarkdown(5))?.level).toBe('partial');
  });

  // Threshold stated with N: fires at K/N <= 0.5, silent above it.
  it('fires when exactly half the titles survive (N=10, K=5)', () => {
    const mixed = `${completeMarkdown(5, 0)}\n${titlelessMarkdown(5, 5)}`;
    expect(assessListTitleAttrition(listPage(10), mixed)?.level).toBe('partial');
  });

  it('stays silent when more than half the titles survive (N=10, K=6)', () => {
    const mixed = `${completeMarkdown(6, 0)}\n${titlelessMarkdown(4, 6)}`;
    expect(assessListTitleAttrition(listPage(10), mixed)).toBeUndefined();
  });

  // NEGATIVE sweep over the real, complete pages already in the corpus. These
  // are the pages the detector must never touch.
  it.each([
    'article.html',
    'blog-post.html',
    'news-article.html',
    'minimal.html',
    'react-reference-real.html',
    'vitepress-guide.html',
    'job-listing.html',
    'product-page.html',
    'tables.html',
  ])('stays silent on the complete fixture %s', async (name) => {
    const html = fixture(name);
    const result = await routedExtract({ html, url: 'https://example.com/page' });
    expect(assessListTitleAttrition(html, result.markdown)).toBeUndefined();
  });

  it('counts non-ASCII titles rather than mangling them into nothing', () => {
    const html =
      '<html><body><main><ul>' +
      Array.from(
        { length: 6 },
        (_, i) =>
          `<li><h3>Ocorrência de criação inválida número ${i}</h3><p>Status: Open. #${2000 + i} relator pessoa${i}</p></li>`,
      ).join('') +
      '</ul></main></body></html>';
    const md = Array.from(
      { length: 6 },
      (_, i) => `*   ### Ocorrência de criação inválida número ${i}\n\n    Status: Open. #${2000 + i} relator pessoa${i}\n`,
    ).join('\n');
    expect(assessListTitleAttrition(html, md)).toBeUndefined();
  });
});

describe('routedExtract on the real GitHub issue list', () => {
  // This is the live defect, frozen. The assertion on the DEFECT itself is
  // deliberate: if the extractor is ever fixed so the titles survive, this test
  // fails and forces the completeness expectation below to be revisited rather
  // than silently continuing to fire on a now-healthy page.
  it('loses 11 of 12 issue titles and labels the result partial', async () => {
    const result = await routedExtract({
      html: githubIssueList,
      url: 'https://github.com/facebook/react/issues',
    });

    const sourceTitles = githubIssueList.match(/data-testid="issue-pr-title-link"/g) ?? [];
    expect(sourceTitles).toHaveLength(12);

    const headings = result.markdown.match(/^\s*#{1,6}\s+\S/gm) ?? [];
    const rowBullets = result.markdown.match(/^\s*\*\s+/gm) ?? [];
    // Structure survived — the caller sees a full-looking list of rows...
    expect(rowBullets.length).toBeGreaterThanOrEqual(10);
    // ...but almost every title is gone.
    expect(headings.length).toBeLessThanOrEqual(3);

    expect(result.contentCompleteness).toEqual({
      level: 'partial',
      reason: 'list_titles_dropped',
      settled_by: 'extraction',
    });
  });

  it('leaves contentCompleteness absent on a complete article', async () => {
    const result = await routedExtract({
      html: fixture('article.html'),
      url: 'https://example.com/article',
    });
    expect(result.contentCompleteness).toBeUndefined();
  });
});
