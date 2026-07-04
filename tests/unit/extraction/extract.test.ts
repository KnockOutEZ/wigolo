import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractMetadata, extractSelector, extractTables } from '../../../src/extraction/extract.js';

describe('extractMetadata', () => {
  it('extracts title from <title> tag', () => {
    const html = '<html><head><title>My Page</title></head><body></body></html>';
    const result = extractMetadata(html);
    expect(result.title).toBe('My Page');
  });

  it('extracts description from meta tag', () => {
    const html = '<html><head><meta name="description" content="A great page"></head><body></body></html>';
    const result = extractMetadata(html);
    expect(result.description).toBe('A great page');
  });

  it('falls back to og:description when meta description missing', () => {
    const html = '<html><head><meta property="og:description" content="OG desc"></head><body></body></html>';
    const result = extractMetadata(html);
    expect(result.description).toBe('OG desc');
  });

  it('prefers meta description over og:description', () => {
    const html = `<html><head>
      <meta name="description" content="Meta desc">
      <meta property="og:description" content="OG desc">
    </head><body></body></html>`;
    const result = extractMetadata(html);
    expect(result.description).toBe('Meta desc');
  });

  it('extracts author from meta tag', () => {
    const html = '<html><head><meta name="author" content="Jane Smith"></head><body></body></html>';
    const result = extractMetadata(html);
    expect(result.author).toBe('Jane Smith');
  });

  it('extracts date from meta date tag', () => {
    const html = '<html><head><meta name="date" content="2025-08-15"></head><body></body></html>';
    const result = extractMetadata(html);
    expect(result.date).toBe('2025-08-15');
  });

  it('falls back to article:published_time for date', () => {
    const html = '<html><head><meta property="article:published_time" content="2025-08-15T10:00:00Z"></head><body></body></html>';
    const result = extractMetadata(html);
    expect(result.date).toBe('2025-08-15T10:00:00Z');
  });

  it('extracts keywords as array', () => {
    const html = '<html><head><meta name="keywords" content="typescript, generics, tutorial"></head><body></body></html>';
    const result = extractMetadata(html);
    expect(result.keywords).toEqual(['typescript', 'generics', 'tutorial']);
  });

  it('extracts og:image', () => {
    const html = '<html><head><meta property="og:image" content="https://example.com/img.png"></head><body></body></html>';
    const result = extractMetadata(html);
    expect(result.og_image).toBe('https://example.com/img.png');
  });

  it('extracts og:type', () => {
    const html = '<html><head><meta property="og:type" content="article"></head><body></body></html>';
    const result = extractMetadata(html);
    expect(result.og_type).toBe('article');
  });

  it('falls back to twitter:image when og:image missing', () => {
    // Some sites (e.g. pgedge.com) ship a
    // twitter:image card without og:image. Surface it as og_image so the
    // extract path matches what site-specific extractors and downstream
    // consumers expect.
    const html = '<html><head><meta name="twitter:image" content="https://example.com/tw.png"></head><body></body></html>';
    const result = extractMetadata(html);
    expect(result.og_image).toBe('https://example.com/tw.png');
  });

  it('prefers og:image over twitter:image when both present', () => {
    const html = `<html><head>
      <meta property="og:image" content="https://example.com/og.png">
      <meta name="twitter:image" content="https://example.com/tw.png">
    </head><body></body></html>`;
    const result = extractMetadata(html);
    expect(result.og_image).toBe('https://example.com/og.png');
  });

  it('falls back to og:image:secure_url when og:image missing', () => {
    const html = '<html><head><meta property="og:image:secure_url" content="https://example.com/secure.png"></head><body></body></html>';
    const result = extractMetadata(html);
    expect(result.og_image).toBe('https://example.com/secure.png');
  });

  it('extracts canonical url from link[rel=canonical]', () => {
    const html = '<html><head><link rel="canonical" href="https://example.com/page"></head><body></body></html>';
    const result = extractMetadata(html);
    expect(result.canonical_url).toBe('https://example.com/page');
  });

  it('returns empty object for HTML with no metadata', () => {
    const html = '<html><head></head><body><p>Hello</p></body></html>';
    const result = extractMetadata(html);
    expect(result.title).toBeUndefined();
    expect(result.description).toBeUndefined();
    expect(result.author).toBeUndefined();
  });

  it('handles all metadata fields together', () => {
    const html = `<html><head>
      <title>Full Page</title>
      <meta name="description" content="Full description">
      <meta name="author" content="John Doe">
      <meta name="date" content="2025-01-01">
      <meta name="keywords" content="a, b, c">
      <meta property="og:image" content="https://example.com/full.png">
    </head><body></body></html>`;
    const result = extractMetadata(html);
    expect(result).toEqual({
      title: 'Full Page',
      description: 'Full description',
      author: 'John Doe',
      date: '2025-01-01',
      keywords: ['a', 'b', 'c'],
      og_image: 'https://example.com/full.png',
    });
  });
});

describe('extractSelector', () => {
  const html = `<html><body>
    <h1>Title</h1>
    <p class="intro">First paragraph</p>
    <p class="intro">Second paragraph</p>
    <div id="main">Main content</div>
    <ul><li>Item 1</li><li>Item 2</li><li>Item 3</li></ul>
  </body></html>`;

  it('extracts text content of first match (multiple=false)', () => {
    const result = extractSelector(html, 'p.intro', false);
    expect(result).toBe('First paragraph');
  });

  it('extracts all matches as array (multiple=true)', () => {
    const result = extractSelector(html, 'p.intro', true);
    expect(result).toEqual(['First paragraph', 'Second paragraph']);
  });

  it('extracts by ID selector', () => {
    const result = extractSelector(html, '#main', false);
    expect(result).toBe('Main content');
  });

  it('extracts list items', () => {
    const result = extractSelector(html, 'li', true);
    expect(result).toEqual(['Item 1', 'Item 2', 'Item 3']);
  });

  it('returns empty string when no match (multiple=false)', () => {
    const result = extractSelector(html, '.nonexistent', false);
    expect(result).toBe('');
  });

  it('returns empty array when no match (multiple=true)', () => {
    const result = extractSelector(html, '.nonexistent', true);
    expect(result).toEqual([]);
  });

  it('trims whitespace from extracted text', () => {
    const spaceyHtml = '<html><body><p>  padded text  </p></body></html>';
    const result = extractSelector(spaceyHtml, 'p', false);
    expect(result).toBe('padded text');
  });
});

describe('extractTables', () => {
  it('extracts a table with headers', () => {
    const html = `<html><body><table>
      <thead><tr><th>Name</th><th>Age</th></tr></thead>
      <tbody>
        <tr><td>Alice</td><td>30</td></tr>
        <tr><td>Bob</td><td>25</td></tr>
      </tbody>
    </table></body></html>`;

    const result = extractTables(html);
    expect(result).toHaveLength(1);
    expect(result[0].headers).toEqual(['Name', 'Age']);
    expect(result[0].rows).toEqual([
      { Name: 'Alice', Age: '30' },
      { Name: 'Bob', Age: '25' },
    ]);
  });

  it('extracts caption when present', () => {
    const html = `<html><body><table>
      <caption>Employee List</caption>
      <thead><tr><th>Name</th></tr></thead>
      <tbody><tr><td>Alice</td></tr></tbody>
    </table></body></html>`;

    const result = extractTables(html);
    expect(result[0].caption).toBe('Employee List');
  });

  it('omits caption when not present', () => {
    const html = `<html><body><table>
      <thead><tr><th>Name</th></tr></thead>
      <tbody><tr><td>Alice</td></tr></tbody>
    </table></body></html>`;

    const result = extractTables(html);
    expect(result[0].caption).toBeUndefined();
  });

  it('extracts multiple tables', () => {
    const html = `<html><body>
      <table><thead><tr><th>A</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>
      <table><thead><tr><th>B</th></tr></thead><tbody><tr><td>2</td></tr></tbody></table>
    </body></html>`;

    const result = extractTables(html);
    expect(result).toHaveLength(2);
    expect(result[0].headers).toEqual(['A']);
    expect(result[1].headers).toEqual(['B']);
  });

  it('extracts headers from <th> in first row when no <thead>', () => {
    const html = `<html><body><table>
      <tr><th>Name</th><th>Age</th></tr>
      <tr><td>Alice</td><td>30</td></tr>
    </table></body></html>`;

    const result = extractTables(html);
    expect(result[0].headers).toEqual(['Name', 'Age']);
    expect(result[0].rows).toEqual([{ Name: 'Alice', Age: '30' }]);
  });

  it('generates column names when no <th> headers exist', () => {
    const html = `<html><body><table>
      <tr><td>Alice</td><td>30</td></tr>
      <tr><td>Bob</td><td>25</td></tr>
    </table></body></html>`;

    const result = extractTables(html);
    expect(result[0].headers).toEqual(['col_1', 'col_2']);
    expect(result[0].rows).toEqual([
      { col_1: 'Alice', col_2: '30' },
      { col_1: 'Bob', col_2: '25' },
    ]);
  });

  it('returns empty array when no tables found', () => {
    const html = '<html><body><p>No tables here</p></body></html>';
    const result = extractTables(html);
    expect(result).toEqual([]);
  });

  it('handles table with empty cells', () => {
    const html = `<html><body><table>
      <thead><tr><th>Name</th><th>Note</th></tr></thead>
      <tbody><tr><td>Alice</td><td></td></tr></tbody>
    </table></body></html>`;

    const result = extractTables(html);
    expect(result[0].rows).toEqual([{ Name: 'Alice', Note: '' }]);
  });

  it('trims cell text content', () => {
    const html = `<html><body><table>
      <thead><tr><th> Name </th></tr></thead>
      <tbody><tr><td>  Alice  </td></tr></tbody>
    </table></body></html>`;

    const result = extractTables(html);
    expect(result[0].headers).toEqual(['Name']);
    expect(result[0].rows).toEqual([{ Name: 'Alice' }]);
  });

  // tables mode on Wikipedia returns CSS-navbox cells ("Cite this page |
  // Wikidata item") instead of real content tables. Skip Wikipedia chrome
  // tables (navbox, role=navigation, infobox-data-row-only patterns) so callers
  // see only meaningful data tables.
  it('skips tables with class="navbox" (Wikipedia chrome)', () => {
    const html = `<html><body>
      <table class="navbox">
        <tr><th>Cite this page</th><th>Wikidata item</th></tr>
        <tr><td>Special:CiteThisPage</td><td>Q1234</td></tr>
      </table>
      <table>
        <thead><tr><th>Year</th><th>Title</th></tr></thead>
        <tbody><tr><td>2020</td><td>Real Content</td></tr></tbody>
      </table>
    </body></html>`;

    const result = extractTables(html);
    expect(result).toHaveLength(1);
    expect(result[0].headers).toEqual(['Year', 'Title']);
    expect(result[0].rows).toEqual([{ Year: '2020', Title: 'Real Content' }]);
  });

  it('skips tables with role="navigation" (Wikipedia chrome)', () => {
    const html = `<html><body>
      <table role="navigation">
        <tr><th>Previous</th><th>Next</th></tr>
        <tr><td>Page A</td><td>Page C</td></tr>
      </table>
      <table>
        <thead><tr><th>Country</th><th>Capital</th></tr></thead>
        <tbody><tr><td>France</td><td>Paris</td></tr></tbody>
      </table>
    </body></html>`;

    const result = extractTables(html);
    expect(result).toHaveLength(1);
    expect(result[0].headers).toEqual(['Country', 'Capital']);
  });

  it('skips infobox chrome rows but keeps real data tables next to them', () => {
    // A Wikipedia article's infobox is page metadata (founder, headquarters,
    // logo) — not a data table. Skip the infobox entirely; keep the prose-
    // adjacent content table that follows.
    const html = `<html><body>
      <table class="infobox">
        <tr><th>Founded</th><td>2021</td></tr>
        <tr><th>Headquarters</th><td>San Francisco</td></tr>
      </table>
      <table>
        <thead><tr><th>Product</th><th>Release</th></tr></thead>
        <tbody><tr><td>Claude</td><td>2023</td></tr></tbody>
      </table>
    </body></html>`;

    const result = extractTables(html);
    expect(result).toHaveLength(1);
    expect(result[0].headers).toEqual(['Product', 'Release']);
  });

  it('keeps non-Wikipedia tables that happen to have a class', () => {
    // Regression guard: only filter known Wikipedia chrome classes/roles.
    // A plain styled table on a regular site must survive.
    const html = `<html><body>
      <table class="data-table styled">
        <thead><tr><th>Key</th><th>Value</th></tr></thead>
        <tbody><tr><td>foo</td><td>bar</td></tr></tbody>
      </table>
    </body></html>`;

    const result = extractTables(html);
    expect(result).toHaveLength(1);
    expect(result[0].rows).toEqual([{ Key: 'foo', Value: 'bar' }]);
  });

  // --- degenerate / nested table handling (item 9) ---
  //
  // WHY: run-on one-cell rows make tables useless to an agent — a whole
  // nested-layout page collapses into one giant string per row, which is
  // exactly why Extract lost benchmark points. Two failure shapes:
  //   1. nested <table> inside a <td>: querySelectorAll('td') double-counts
  //      the inner table's cells and merges them into the parent row.
  //   2. legacy single-<td>-per-row layout: headers collapse to ['col_1']
  //      and every row becomes a run-on blob of the whole cell text.

  it('scopes row cells to direct children so a nested table does not merge into the parent row', () => {
    // Outer layout table whose single <td> wraps a real inner data table.
    const html = `<html><body>
      <table>
        <tr>
          <td>
            <table>
              <thead><tr><th>City</th><th>Population</th></tr></thead>
              <tbody>
                <tr><td>Paris</td><td>2.1M</td></tr>
                <tr><td>Berlin</td><td>3.6M</td></tr>
              </tbody>
            </table>
          </td>
        </tr>
      </table>
    </body></html>`;

    const result = extractTables(html);
    // The inner data table must surface with correct per-column cells.
    const inner = result.find(
      (t) =>
        t.headers.join(',') === 'City,Population' &&
        t.rows.length === 2 &&
        t.rows[0].City === 'Paris',
    );
    expect(inner).toBeDefined();
    expect(inner!.rows).toEqual([
      { City: 'Paris', Population: '2.1M' },
      { City: 'Berlin', Population: '3.6M' },
    ]);
    // The outer layout table must NOT re-emit the inner table's data by
    // descending into it: scoping row cells to direct children means the
    // outer <td> wraps the inner <table> but contributes no data rows itself,
    // so the inner table appears exactly ONCE (no duplicate).
    const innerCopies = result.filter(
      (t) => t.headers.join(',') === 'City,Population' && t.rows.length === 2,
    );
    expect(innerCopies).toHaveLength(1);
    // And never a row whose single cell concatenates the whole inner table.
    for (const table of result) {
      for (const row of table.rows) {
        const values = Object.values(row);
        expect(values.some((v) => v.includes('Paris') && v.includes('Berlin'))).toBe(false);
      }
    }
  });

  it('does not emit a legacy single-<td>-per-row layout table as run-on blobs', () => {
    // Each row has exactly one <td> carrying a long paragraph — a classic
    // layout table, not data. headers would collapse to ['col_1'].
    const blob1 = 'This is a long promotional paragraph about our flagship product line that stretches well beyond any sane single-column cell width and reads as prose.';
    const blob2 = 'A second equally verbose marketing paragraph continues the layout table pattern with more run-on text that clearly is not tabular data at all.';
    const html = `<html><body>
      <table>
        <tr><td>${blob1}</td></tr>
        <tr><td>${blob2}</td></tr>
      </table>
    </body></html>`;

    const result = extractTables(html);
    // Invariant: no emitted row is a single key whose value exceeds a run-on
    // threshold when it came from a degenerate single-cell layout table.
    for (const table of result) {
      for (const row of table.rows) {
        const keys = Object.keys(row);
        if (keys.length === 1) {
          expect(row[keys[0]].length).toBeLessThanOrEqual(120);
        }
      }
    }
    // If it was salvaged as a list, rows are keyed by `item`, not `col_1`.
    for (const table of result) {
      expect(table.headers).not.toEqual(['col_1']);
    }
  });

  it('regression: well-formed tables.html fixture parses byte-identical to prior behavior', () => {
    // The degenerate classifier must never touch clean, structured tables.
    const html = readFileSync(
      join(import.meta.dirname, '../../fixtures/extraction/tables.html'),
      'utf-8',
    );
    const result = extractTables(html);
    expect(result).toEqual([
      {
        caption: undefined,
        headers: ['Quarter', 'Revenue', 'Growth', 'Profit Margin'],
        rows: [
          { Quarter: 'Q1 2025', Revenue: '$1.2M', Growth: '12%', 'Profit Margin': '34%' },
          { Quarter: 'Q2 2025', Revenue: '$1.5M', Growth: '25%', 'Profit Margin': '36%' },
          { Quarter: 'Q3 2025', Revenue: '$1.8M', Growth: '20%', 'Profit Margin': '38%' },
          { Quarter: 'Q4 2025', Revenue: '$2.1M', Growth: '17%', 'Profit Margin': '40%' },
        ],
      },
      {
        caption: undefined,
        headers: ['Product', 'Units Sold', 'Revenue', 'Customer Satisfaction'],
        rows: [
          { Product: 'Widget Pro', 'Units Sold': '15,000', Revenue: '$3.0M', 'Customer Satisfaction': '4.5/5' },
          { Product: 'Widget Lite', 'Units Sold': '42,000', Revenue: '$2.1M', 'Customer Satisfaction': '4.2/5' },
          { Product: 'Widget Enterprise', 'Units Sold': '500', Revenue: '$1.5M', 'Customer Satisfaction': '4.8/5' },
        ],
      },
    ]);
  });

  it('keeps a well-formed two-column key/value layout table (amazon-style spec table)', () => {
    // A 2-col td/td spec table (no thead) is legitimate structured data —
    // the degenerate classifier keys on single-cell rows, not on 2+ cols.
    const html = `<html><body>
      <table class="a-normal">
        <tr><td>Brand</td><td>Acme</td></tr>
        <tr><td>Color</td><td>Black</td></tr>
        <tr><td>Model</td><td>NC-700</td></tr>
      </table>
    </body></html>`;

    const result = extractTables(html);
    expect(result).toHaveLength(1);
    expect(result[0].headers).toEqual(['col_1', 'col_2']);
    expect(result[0].rows).toEqual([
      { col_1: 'Brand', col_2: 'Acme' },
      { col_1: 'Color', col_2: 'Black' },
      { col_1: 'Model', col_2: 'NC-700' },
    ]);
  });
});

// --- interleaved multi-row-per-record listing segmentation ---
//
// WHY: legacy nested-table listings (HN-class front pages) lay out each story
// as a CYCLE of rows — a rank+title row, a points/comments meta row, then a
// spacer — inside one header-less <table>. extractTables synthesised col_1..3
// and emitted every physical <tr> as its own row, so a 30-story page became an
// interleaved run-on dump ({col_1:"1.",col_3:"Title"} then {col_2:"342 points
// ..."} then an all-empty spacer). That dump is useless to an agent AND, having
// only col_N headers, matches no schema field so schema mode returns {}. The
// listing must segment to ONE clean row per story with the title + meta
// co-located, so a caller (and schema fuzzy-match) can read one record per row.
//
// The segmentation is PER-STRUCTURE: it fires only for a header-less listing
// whose rows are sparse and cycle on a record-start signal (a leading rank
// ordinal), NEVER for a well-formed dense data grid. Negative tests below lock
// that boundary so a future change can't over-fire it onto real tables.
describe('interleaved multi-row-per-record listing (HN-class)', () => {
  const athingStory = (
    rank: number,
    id: number,
    title: string,
    site: string,
    points: number,
    user: string,
    comments: number,
  ): string => `
    <tr class="athing submission" id="${id}">
      <td class="title"><span class="rank">${rank}.</span></td>
      <td class="votelinks"><center><a href="vote?id=${id}"><div class="votearrow"></div></a></center></td>
      <td class="title"><span class="titleline"><a href="https://${site}/a/${id}">${title}</a><span class="sitebit comhead"> (<a href="from?site=${site}"><span class="sitestr">${site}</span></a>)</span></span></td>
    </tr>
    <tr>
      <td colspan="2"></td>
      <td class="subtext"><span class="subline"><span class="score" id="score_${id}">${points} points</span> by <a href="user?id=${user}" class="hnuser">${user}</a> <span class="age"><a href="item?id=${id}">3 hours ago</a></span> | <a href="item?id=${id}">${comments} comments</a></span></td>
    </tr>
    <tr class="spacer" style="height:5px"></tr>`;

  const listingHtml = `<html><body><center>
    <table id="hnmain"><tr><td>
      <table class="itemlist">
        ${athingStory(1, 40001, 'A local-first search engine in Rust', 'example.com', 342, 'alice', 128)}
        ${athingStory(2, 40002, 'The hidden cost of microservices', 'blog.example.org', 211, 'bob', 87)}
        ${athingStory(3, 40003, 'Migrating from Postgres to SQLite', 'devblog.io', 189, 'carol', 64)}
        ${athingStory(4, 40004, 'How do you stay productive remotely?', 'ask.test', 156, 'dave', 203)}
      </table>
    </td></tr></table>
  </center></body></html>`;

  it('segments each story into ONE row instead of an interleaved col_1..3 dump', () => {
    const result = extractTables(listingHtml);

    // Find the listing table: the one carrying the story titles.
    const listing = result.find((t) =>
      t.rows.some((r) => Object.values(r).some((v) => v.includes('local-first search engine'))),
    );
    expect(listing).toBeDefined();

    // Exactly one row per story — not one row per physical <tr>.
    expect(listing!.rows).toHaveLength(4);

    // Each story's title and its own points/comments meta land in the SAME row,
    // so a reader sees one record per row rather than a scattered dump.
    const first = listing!.rows[0];
    const firstText = Object.values(first).join(' ');
    expect(firstText).toContain('A local-first search engine in Rust');
    expect(firstText).toContain('342 points');
    expect(firstText).toContain('128 comments');

    const second = listing!.rows[1];
    const secondText = Object.values(second).join(' ');
    expect(secondText).toContain('The hidden cost of microservices');
    expect(secondText).toContain('211 points');
    // Story 1's data must NOT bleed into story 2's row.
    expect(secondText).not.toContain('local-first search engine');
    expect(secondText).not.toContain('342 points');
  });

  it('emits no all-empty rows and no header-less col_N dump for the listing', () => {
    const result = extractTables(listingHtml);
    const listing = result.find((t) =>
      t.rows.some((r) => Object.values(r).some((v) => v.includes('local-first search engine'))),
    );
    expect(listing).toBeDefined();

    // No spacer/all-empty rows survive segmentation.
    for (const row of listing!.rows) {
      const nonEmpty = Object.values(row).filter((v) => v.trim().length > 0);
      expect(nonEmpty.length).toBeGreaterThan(0);
    }
    // The segmented rows carry the actual record fields — not the useless
    // header-less col_N shape whose keys match no schema field.
    expect(listing!.rows.length).toBe(4);
  });

  it('NEGATIVE: a well-formed dense multi-column data table is NOT segmented', () => {
    // Every row is fully populated and there is no leading-ordinal record-start
    // cycle: this is real tabular data and must pass through untouched.
    const html = `<html><body>
      <table>
        <thead><tr><th>City</th><th>Population</th><th>Country</th></tr></thead>
        <tbody>
          <tr><td>Paris</td><td>2.1M</td><td>France</td></tr>
          <tr><td>Berlin</td><td>3.6M</td><td>Germany</td></tr>
          <tr><td>Madrid</td><td>3.2M</td><td>Spain</td></tr>
          <tr><td>Rome</td><td>2.8M</td><td>Italy</td></tr>
        </tbody>
      </table>
    </body></html>`;
    const result = extractTables(html);
    expect(result).toHaveLength(1);
    expect(result[0].headers).toEqual(['City', 'Population', 'Country']);
    expect(result[0].rows).toEqual([
      { City: 'Paris', Population: '2.1M', Country: 'France' },
      { City: 'Berlin', Population: '3.6M', Country: 'Germany' },
      { City: 'Madrid', Population: '3.2M', Country: 'Spain' },
      { City: 'Rome', Population: '2.8M', Country: 'Italy' },
    ]);
  });

  it('NEGATIVE: a header-less col_N table with dense rows and no rank cycle is NOT merged', () => {
    // No <th>, so headers synthesise to col_N — but every row is fully
    // populated and none starts with a rank ordinal. This is a plain no-header
    // data table (row-per-record already); it must stay one row per <tr>.
    const html = `<html><body>
      <table>
        <tr><td>Alice</td><td>Engineer</td><td>NYC</td></tr>
        <tr><td>Bob</td><td>Designer</td><td>LA</td></tr>
        <tr><td>Carol</td><td>PM</td><td>SF</td></tr>
        <tr><td>Dave</td><td>QA</td><td>Austin</td></tr>
      </table>
    </body></html>`;
    const result = extractTables(html);
    expect(result).toHaveLength(1);
    expect(result[0].headers).toEqual(['col_1', 'col_2', 'col_3']);
    expect(result[0].rows).toHaveLength(4);
    expect(result[0].rows[0]).toEqual({ col_1: 'Alice', col_2: 'Engineer', col_3: 'NYC' });
  });
});
