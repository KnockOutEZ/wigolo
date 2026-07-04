import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractTables } from '../../../src/extraction/extract.js';
import { detectDivGridTables } from '../../../src/extraction/div-grid.js';
import { detectListTables } from '../../../src/extraction/list.js';
import { extractStructured } from '../../../src/extraction/structured.js';

// BOTH-WAYS regression lock.
//
// Two structurally-opposite pages both flow through structured extraction and
// have historically traded blows: a round-1 fix taught legacy nested-table
// listings (HN-class front pages) to segment PER STORY, and a round-2 div-grid
// detector taught div/flex PRICING grids to surface their tiers. A change to
// either path must not silently regress the other. These fixture tests fail on
// a naive revert of the segmentation fix (listing side) AND on a regression of
// the div-grid detector (pricing side), so neither win can be quietly lost.

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dirname, '../../fixtures/extraction', name), 'utf-8');

describe('legacy nested-table listing → per-story rows (round-1 win)', () => {
  // The fixture deliberately uses NON-Hacker-News tag/class names (<b>N.</b>
  // ranks, .entry/.subject/.stats — no athing/titleline/hnuser) so the test
  // proves the segmentation keys on STRUCTURE (header-less table + rank-ordinal
  // cycle + sparse rows), not on any HN-specific string.
  const html = fixture('legacy-table-listing.html');

  it('collapses each thread cycle into ONE row instead of an interleaved dump', () => {
    const tables = extractTables(html);
    const listing = tables.find((t) =>
      t.rows.some((r) => Object.values(r).some((v) => v.includes('lock-free ring buffer'))),
    );
    expect(listing).toBeDefined();

    // Five threads, five rows — not one row per physical <tr> (which would be
    // ~15 with mostly-empty interleaved cells).
    expect(listing!.rows).toHaveLength(5);

    // Each thread's subject and its own vote/reply meta land in the SAME row.
    const first = listing!.rows[0];
    const firstText = Object.values(first).join(' ');
    expect(firstText).toContain('Designing a lock-free ring buffer for audio');
    expect(firstText).toContain('184 votes');
    expect(firstText).toContain('57 replies');

    // No thread's data bleeds into the next thread's row.
    const second = Object.values(listing!.rows[1]).join(' ');
    expect(second).toContain('column-oriented storage');
    expect(second).not.toContain('lock-free ring buffer');
    expect(second).not.toContain('184 votes');
  });

  it('emits no all-empty rows and no header-less col_N dump', () => {
    const tables = extractTables(html);
    const listing = tables.find((t) =>
      t.rows.some((r) => Object.values(r).some((v) => v.includes('lock-free ring buffer'))),
    );
    expect(listing).toBeDefined();

    // Segmented headers are the derived record fields — never the useless
    // col_N shape that matches no schema field.
    expect(listing!.headers.every((h) => /^col_\d+$/.test(h))).toBe(false);
    for (const row of listing!.rows) {
      const nonEmpty = Object.values(row).filter((v) => v.trim().length > 0);
      expect(nonEmpty.length).toBeGreaterThan(0);
    }
  });

  it('feeds a non-{} array-of-objects schema match as a consequence', () => {
    // The point of segmenting: schema mode reads one record per row. With the
    // interleaved col_N dump this returned {} (no header matched a field name).
    const tables = extractStructured(html).tables;
    const listing = tables.find((t) =>
      t.rows.some((r) => Object.values(r).some((v) => v.includes('lock-free ring buffer'))),
    );
    expect(listing).toBeDefined();
    // The derived headers (title/meta) are real field names a schema can hit.
    expect(listing!.headers).toContain('title');
    expect(listing!.rows.every((r) => (r.title ?? '').length > 0)).toBe(true);
  });

  it('SPARSITY GATE: a DENSE ordinal leaderboard is NOT collapsed to rank/title/meta', () => {
    // The fixture is tuned so the SPARSITY gate is the deciding gate: most rows
    // are rank-led (1./2./3.…) but two are non-ordinal, so the record-start
    // rows are a MINORITY (the `starts < bodyRows` and `>=3 records` checks both
    // pass). Every cell is populated (no empty cells, no spacer rows), so
    // filled/gridCells ≈ 1.0 — well above the < 0.5 bar. Only the sparsity gate
    // rejects segmentation here. This is real tabular data and must stay one row
    // per <tr> (col_N), never folded. Without this test, loosening the 0.5
    // threshold would silently over-fire on dense leaderboards.
    const leaderboard = fixture('dense-ordinal-leaderboard.html');
    const tables = extractTables(leaderboard);
    expect(tables).toHaveLength(1);
    const table = tables[0];

    // Dense per-row shape survives: synthesized col_N headers, one row per team.
    expect(table.headers).toEqual(['col_1', 'col_2', 'col_3', 'col_4']);
    expect(table.rows).toHaveLength(8);
    expect(table.rows[0]).toEqual({
      col_1: '1.',
      col_2: 'Northwind United',
      col_3: '34',
      col_4: '+41',
    });

    // It must NOT have been folded into the segmenter's rank/title/meta shape.
    expect(table.headers).not.toContain('title');
    expect(table.headers).not.toContain('meta');
  });
});

describe('div/flex pricing grid → tier capture (round-2 win)', () => {
  const html = fixture('div-grid-pricing.html');

  it('detects the grid and captures every tier name + price (incl. non-numeric)', () => {
    const grids = detectDivGridTables(html);
    expect(grids).toHaveLength(1);
    const grid = grids[0];
    const names = grid.rows.map((r) => r.name);
    expect(names).toEqual(['Free', 'Basic', 'Business', 'Enterprise']);
    const prices = grid.rows.map((r) => r.price);
    expect(prices[0]).toBe('$0');
    // The top tier's NON-numeric price cue is recovered (the round-2 relax).
    expect(prices[3]).toBe('Custom');
    // Feature bullets surface as feature_* columns.
    expect(grid.headers.some((h) => /^feature_\d+$/.test(h))).toBe(true);
  });

  it('the listing segmenter never touches a div-grid (no <table> markup)', () => {
    // The pricing grid carries no <table>, so extractTables — where the
    // per-story segmentation lives — must yield nothing and can never mistake a
    // pricing grid for a listing.
    const tables = extractTables(html);
    expect(tables).toHaveLength(0);
    // And the div-grid rows must NOT be shaped like the segmenter's output.
    const grids = detectDivGridTables(html);
    expect(grids[0].headers).not.toContain('meta');
    expect(grids[0].headers).not.toContain('rank');
  });
});

// THREE-WAY BOTH-WAYS LOCK.
//
// Structured extraction now runs THREE structural detectors — extractTables
// (<table>), detectDivGridTables (div/flex cards), detectListTables
// (<ol>/<ul> listings). A round-N change to any ONE has historically regressed
// another (round-2 improving the div-grid silently broke listing segmentation).
// This matrix proves each detector (a) FIRES on its own shape and (b) does NOT
// mis-handle the other two shapes. If a future change lets one detector
// cannibalise another, exactly one of these assertions breaks.

// Shape 1: a semantic <table> data grid.
const TABLE_SHAPE = `<html><body><table>
  <thead><tr><th>City</th><th>Population</th></tr></thead>
  <tbody>
    <tr><td>Paris</td><td>2.1M</td></tr>
    <tr><td>Berlin</td><td>3.6M</td></tr>
    <tr><td>Madrid</td><td>3.2M</td></tr>
  </tbody>
</table></body></html>`;

// Shape 2: a div/flex pricing grid of >=3 parallel cards.
const DIVGRID_SHAPE = `<html><body><main><section class="pricing"><h2>Plans</h2>
  <div class="tiers">
    <div class="plan"><h3>Starter</h3><span class="price">$9</span><ul><li>10 seats</li></ul></div>
    <div class="plan"><h3>Pro</h3><span class="price">$29</span><ul><li>50 seats</li></ul></div>
    <div class="plan"><h3>Enterprise</h3><span class="price">$99</span><ul><li>Unlimited</li></ul></div>
  </div>
</section></main></body></html>`;

// Shape 3: an <ol>/<ul> repeated-sibling listing of linked items with metrics.
const LIST_SHAPE = `<html><body><main><ol class="feed">
  <li><a href="/p/ring-buffer">Lock-free ring buffer</a> <span>184 points</span> <span>57 comments</span></li>
  <li><a href="/p/columnar">Column-oriented storage</a> <span>92 points</span> <span>31 comments</span></li>
  <li><a href="/p/wasm">Compiling to WebAssembly</a> <span>211 points</span> <span>88 comments</span></li>
</ol></main></body></html>`;

describe('three-way detector cannibalization lock', () => {
  describe('<table> shape', () => {
    it('POSITIVE: extractTables fires and yields the data rows', () => {
      const t = extractTables(TABLE_SHAPE);
      expect(t).toHaveLength(1);
      expect(t[0].headers).toEqual(['City', 'Population']);
      expect(t[0].rows).toHaveLength(3);
    });
    it('MUST-NOT-FIRE: the div-grid detector ignores <table> markup', () => {
      expect(detectDivGridTables(TABLE_SHAPE)).toHaveLength(0);
    });
    it('MUST-NOT-FIRE: the list detector ignores a <table> (no <ol>/<ul>)', () => {
      expect(detectListTables(TABLE_SHAPE)).toHaveLength(0);
    });
  });

  describe('div-grid shape', () => {
    it('POSITIVE: the div-grid detector fires and yields one row per card', () => {
      const g = detectDivGridTables(DIVGRID_SHAPE);
      expect(g).toHaveLength(1);
      expect(g[0].rows).toHaveLength(3);
      expect(g[0].rows.map((r) => r.name)).toEqual(['Starter', 'Pro', 'Enterprise']);
    });
    it('MUST-NOT-FIRE: extractTables ignores a card grid (no <table>)', () => {
      expect(extractTables(DIVGRID_SHAPE)).toHaveLength(0);
    });
    it('MUST-NOT-FIRE: the list detector does not turn a card grid into a listing', () => {
      // The cards use <ul><li>10 seats</li></ul> internally, but each list has
      // only ONE <li> (below the >=3 gate), so no phantom listing is emitted.
      expect(detectListTables(DIVGRID_SHAPE)).toHaveLength(0);
    });
  });

  describe('<ol>/<ul> list shape', () => {
    it('POSITIVE: the list detector fires with hrefs + typed metrics', () => {
      const l = detectListTables(LIST_SHAPE);
      expect(l).toHaveLength(1);
      expect(l[0].rows).toHaveLength(3);
      expect(l[0].rows[0].href).toBe('/p/ring-buffer');
      const nums = Object.values(l[0].rows[0]).filter((v) => /^\d+$/.test(v));
      expect(nums).toContain('184');
    });
    it('MUST-NOT-FIRE: extractTables ignores a bare <ol> (no <table>)', () => {
      expect(extractTables(LIST_SHAPE)).toHaveLength(0);
    });
    it('MUST-NOT-FIRE: the div-grid detector does not treat <li> items as cards', () => {
      // <li> is not a table tag, but the div-grid card gate needs a price/
      // numeric-cell signal AND >=3 parallel non-<li>-listing siblings. A plain
      // linked listing with per-item spans must not manufacture a card grid.
      const g = detectDivGridTables(LIST_SHAPE);
      // If the div-grid detector fires here it would double-report the listing
      // AND shape it wrong (name/price/feature columns instead of title/href).
      expect(g.every((t) => !t.rows.some((r) => r.href))).toBe(true);
      expect(g).toHaveLength(0);
    });
  });

  describe('fresh over-fire probe: an ordinary article is untouched by all three', () => {
    // A prose article with a couple of inline links and a short bullet list of
    // nav labels — none of the three detectors may manufacture a table.
    const ARTICLE = `<html><body><article>
      <h1>Understanding memory ordering</h1>
      <p>See the <a href="/spec">spec</a> and the <a href="/faq">FAQ</a> for details.</p>
      <p>Memory ordering matters when threads share state without locks.</p>
      <ul><li>Home</li><li>Guides</li><li>Reference</li></ul>
    </article></body></html>`;
    it('no phantom tables from any detector', () => {
      expect(extractTables(ARTICLE)).toHaveLength(0);
      expect(detectDivGridTables(ARTICLE)).toHaveLength(0);
      expect(detectListTables(ARTICLE)).toHaveLength(0);
      expect(extractStructured(ARTICLE).tables).toHaveLength(0);
    });
  });
});
