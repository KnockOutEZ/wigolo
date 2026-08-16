import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assessListTitleAttrition,
  analyzeListTitleAttrition,
  mergeCompleteness,
} from '../../../src/extraction/completeness.js';
import { routedExtract } from '../../../src/extraction/v1/routed.js';
import type { ContentCompleteness } from '../../../src/types.js';

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

  // NEGATIVE. A list dropped WHOLESALE (related-links rail, nav TOC) is a
  // correct extraction decision, not attrition.
  //
  // The output here deliberately has PLENTY of bullets — they just belong to a
  // different part of the page. That is the whole point: a page-wide "are there
  // still bullets?" test passes this input and would fire, so this input is
  // what forces the per-row scoping to actually exist. A version of this test
  // with an empty output would short-circuit on the pre-filter and could never
  // fail, no matter how the residue rule were mutated.
  it('stays silent when a dropped rail coexists with unrelated bullets that survived', () => {
    const railRows = Array.from(
      { length: 8 },
      (_, i) =>
        `<li><h3><a href="/p/${i}">Archive essay ${TITLE_WORDS[i]} retrospective</a></h3><p>March ${2010 + i} &middot; ${4 + i} min read</p></li>`,
    ).join('');
    const html =
      `<html><body><main><article><h1>Shipping safely</h1>` +
      `<ul>${Array.from({ length: 6 }, (_, i) => `<li>Deployment checklist item ${i}: verify the migration ran cleanly.</li>`).join('')}</ul>` +
      `</article><aside><ul>${railRows}</ul></aside></main></body></html>`;
    // Exactly what a correct extraction returns: the article and its own list,
    // with the rail gone. Six bullets present, none of them the dropped rows.
    const md =
      '# Shipping safely\n\n' +
      Array.from(
        { length: 6 },
        (_, i) => `*   Deployment checklist item ${i}: verify the migration ran cleanly.`,
      ).join('\n');

    const analysis = analyzeListTitleAttrition(html, md);
    // The rail rows DID enter the denominator — this is not passing by N = 0.
    expect(analysis.titledRows).toBe(8);
    expect(analysis.guttedRows).toBe(0);
    expect(analysis.verdict).toBeUndefined();
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

  // Regression sweep over the real pages already in the corpus, driven through
  // the PRODUCTION path so it sees the same narrowed HTML routedExtract feeds
  // the detector. These are all N = 0 pages, so this guards against the
  // detector reaching pages it has no business touching — it is not a test of
  // the ratio itself, which the cases above cover.
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
    const result = await routedExtract({
      html: fixture(name),
      url: 'https://example.com/page',
    });
    expect(result.contentCompleteness).toBeUndefined();
  });

  // Titles in a non-Latin script. Latin-1 accents are NOT enough to test this:
  // an ASCII-only class shreds "Ocorrência" into ocorr/ncia/inv/lida, which
  // still clears the 2-token minimum, so the row stays in the denominator and
  // the mutant survives. Cyrillic fragments to NOTHING under an ASCII class,
  // which is what makes the denominator assertion below load-bearing.
  const cyrillicRows = (count: number) =>
    '<html><body><main><ul>' +
    Array.from(
      { length: count },
      (_, i) =>
        `<li><h3>Ошибка гидратации диалога ${i}</h3><p>Status: Open. #${2000 + i} relator pessoa${i}</p></li>`,
    ).join('') +
    '</ul></main></body></html>';

  it('tokenizes non-Latin titles well enough for them to enter the denominator', () => {
    const md = Array.from(
      { length: 6 },
      (_, i) =>
        `*   ### Ошибка гидратации диалога ${i}\n\n    Status: Open. #${2000 + i} relator pessoa${i}\n`,
    ).join('\n');

    const analysis = analyzeListTitleAttrition(cyrillicRows(6), md);
    expect(analysis.titledRows).toBe(6);
    expect(analysis.guttedRows).toBe(0);
    expect(analysis.verdict).toBeUndefined();
  });

  // The same rows with their titles stripped MUST fire. An ASCII-only
  // tokenizer empties these titles, drops the rows from the denominator, and
  // silences this fire — so this is the assertion that kills that mutant.
  it('fires on non-Latin rows whose titles were dropped', () => {
    const md = Array.from(
      { length: 6 },
      (_, i) => `*   Status: Open. #${2000 + i} relator pessoa${i}\n`,
    ).join('\n');

    const analysis = analyzeListTitleAttrition(cyrillicRows(6), md);
    expect(analysis.titledRows).toBe(6);
    expect(analysis.guttedRows).toBe(6);
    expect(analysis.verdict?.level).toBe('partial');
  });

  // The floor exists to keep SMALL lists out. A heading inside a nested row
  // belongs to that row; letting the outer row borrow it lets a 3-item list
  // present as 6 and walk straight through the floor.
  it('does not let an outer row borrow the titles of its nested rows', () => {
    const inner = Array.from(
      { length: 3 },
      (_, i) => `<li><h3>${titleFor(i)}</h3><p>${residueFor(i)}</p></li>`,
    ).join('');
    const html = `<html><body><main><ul><li><h3>${titleFor(9)}</h3><ul>${inner}</ul></li></ul></main></body></html>`;
    const md = `*   ${residueFor(0)}\n*   ${residueFor(1)}\n*   ${residueFor(2)}\n`;

    // 4 rows carry their own heading, not 8. Below the floor, so no verdict.
    expect(analyzeListTitleAttrition(html, md).titledRows).toBe(4);
  });
});

describe('mergeCompleteness', () => {
  const renderFull: ContentCompleteness = {
    level: 'full',
    reason: 'stable_content',
    settled_by: 'stability',
  };
  const extractionPartial: ContentCompleteness = {
    level: 'partial',
    reason: 'list_titles_dropped',
    settled_by: 'extraction',
  };

  // THE case the whole signal turns on. The browser tier returns a verdict on
  // every capture and `full` is its ordinary outcome, so a plain "render wins"
  // rule would publish `full` over structural proof of loss — a positive claim
  // of completeness the pipeline knows to be false. That is the same class of
  // harm this signal exists to prevent, one layer up.
  it('lets an extraction partial win over a browser full', () => {
    expect(mergeCompleteness(renderFull, extractionPartial)).toEqual(extractionPartial);
  });

  it('lets a browser shell win over an extraction partial', () => {
    const shell: ContentCompleteness = {
      level: 'shell',
      reason: 'app_shell',
      settled_by: 'budget',
    };
    expect(mergeCompleteness(shell, extractionPartial)).toEqual(shell);
  });

  // Ties go to the browser: watching a page settle beats inspecting bytes after
  // the fact, so its reason string is the more informative one to surface.
  it('prefers the render verdict when both agree on severity', () => {
    const renderPartial: ContentCompleteness = {
      level: 'partial',
      reason: 'never_settled',
      settled_by: 'budget',
    };
    expect(mergeCompleteness(renderPartial, extractionPartial)).toEqual(renderPartial);
  });

  it('passes either verdict through when only one exists', () => {
    expect(mergeCompleteness(undefined, extractionPartial)).toEqual(extractionPartial);
    expect(mergeCompleteness(renderFull, undefined)).toEqual(renderFull);
    expect(mergeCompleteness(undefined, undefined)).toBeUndefined();
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
