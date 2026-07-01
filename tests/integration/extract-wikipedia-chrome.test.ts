// Integration test at the tool boundary for Wikipedia chrome filtering:
//
//   - `extract` tables mode on Wikipedia returns CSS-navbox cells
//     ("Cite this page | Wikidata item") instead of real content tables.
//     The tool boundary must drop navbox/infobox/role=navigation tables
//     before they ever land in the user-facing payload.
//
//   - `extract` named_schema=Article on a Wikipedia-shaped page dumped
//     30KB of body text including references / LaTeX / infobox chrome.
//     The tool boundary must surface a cleaned Article body that excludes
//     the references section, LaTeX `$$ … $$` math blocks, and Wikipedia
//     infobox/navbox tables — while preserving real article prose.
//
// Runs entirely against the in-memory cache + the HTML-only branch of
// handleExtract (no HTTP server), so the test is safe under sandboxes that
// block listen() syscalls.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { handleExtract } from '../../src/tools/extract.js';
import { initDatabase, closeDatabase } from '../../src/cache/db.js';
import { resetConfig } from '../../src/config.js';
import type { SmartRouter } from '../../src/fetch/router.js';

function makeRouter(): SmartRouter {
  // handleExtract takes the `html` branch — router is never invoked.
  return {} as unknown as SmartRouter;
}

describe('extract — Wikipedia chrome filtering (tables + Article body)', () => {
  beforeEach(() => {
    resetConfig();
    initDatabase(':memory:');
  });

  afterEach(() => {
    closeDatabase();
    resetConfig();
  });

  it('tables mode drops Wikipedia navbox / infobox / role=navigation', async () => {
    const wikipediaLikeHtml = `<html><body>
      <table class="navbox">
        <tr><th>Cite this page</th><th>Wikidata item</th></tr>
        <tr><td>Special:CiteThisPage</td><td>Q1234</td></tr>
      </table>
      <table class="infobox">
        <tr><th>Founded</th><td>2021</td></tr>
      </table>
      <table role="navigation">
        <tr><th>Prev</th><th>Next</th></tr>
        <tr><td>A</td><td>C</td></tr>
      </table>
      <table>
        <thead><tr><th>Year</th><th>Title</th></tr></thead>
        <tbody><tr><td>2023</td><td>Claude 1</td></tr></tbody>
      </table>
    </body></html>`;

    const __r = await handleExtract(
      { html: wikipediaLikeHtml, mode: 'tables' },
      makeRouter(),
    );
    expect(__r.ok).toBe(true);
    const out = __r.ok ? __r.data : ({} as Record<string, unknown>);
    const tables = out.data as Array<{ headers: string[]; rows: Array<Record<string, string>> }>;
    expect(tables).toHaveLength(1);
    expect(tables[0].headers).toEqual(['Year', 'Title']);
    expect(tables[0].rows[0]).toEqual({ Year: '2023', Title: 'Claude 1' });
  });

  it('named_schema=Article on Wikipedia-shaped HTML strips refs, LaTeX, infobox/navbox', async () => {
    // Regression for a Wikipedia-page failure: real article prose
    // ("Claude is an LLM …") must survive while references, LaTeX math, and
    // Wikipedia chrome get filtered before reaching the user.
    const wikipediaArticleHtml = `<html>
      <head><title>Claude (AI)</title></head>
      <body>
        <table class="infobox">
          <tr><th>Developer</th><td>Anthropic</td></tr>
        </table>
        <article>
          <p>Claude is a family of large language models developed by Anthropic.</p>
          <p>Released in 2023, Claude is trained with constitutional AI.</p>
          <p>The model's loss is given by $$L = -\\sum p_i \\log q_i$$ across the corpus.</p>
          <p>Another paragraph of substantive prose that should clearly survive any filter.</p>
          <p>And one more paragraph after the math so the body is comfortably above the readability minimum threshold.</p>
          <h2 id="References">References</h2>
          <ol class="references">
            <li>Smith, J. "Claude paper." 2023.</li>
            <li>Doe, A. "Another paper." 2024.</li>
          </ol>
          <table class="navbox">
            <tr><th>Cite this page</th><th>Wikidata item</th></tr>
          </table>
        </article>
      </body>
    </html>`;

    const __r = await handleExtract(
      {
        html: wikipediaArticleHtml,
        named_schema: 'Article',
      },
      makeRouter(),
    );
    expect(__r.ok).toBe(true);
    const out = __r.ok ? __r.data : ({} as Record<string, unknown>);
    const data = out.data as Record<string, unknown>;
    const body = String(data.body ?? '');
    expect(body.length).toBeGreaterThan(0);

    // Positive: real article prose survives.
    expect(body).toContain('Claude is a family');

    // Negative: references section title and entries must be stripped.
    expect(body.toLowerCase()).not.toContain('references');
    expect(body).not.toContain('Smith, J.');

    // Negative: LaTeX `$$ … $$` math blocks must be stripped.
    expect(body).not.toContain('$$');
    expect(body).not.toContain('\\sum');

    // Negative: Wikipedia infobox/navbox text must NOT leak into the body.
    expect(body).not.toContain('Cite this page');
    expect(body).not.toContain('Wikidata item');
  });
});
