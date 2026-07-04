import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractStructured } from '../../../src/extraction/structured.js';
import { detectDivGridTables } from '../../../src/extraction/div-grid.js';

// A 3-card flex/div pricing grid — the single biggest Extract miss. Cards use
// <div>, not <table>, so extractTables returns []. The detector recognises
// >=3 structurally-parallel siblings and emits one TableData.
const THREE_CARD_GRID = `
  <html><body>
    <section class="pricing">
      <h2>Plans</h2>
      <div class="tiers">
        <div class="plan">
          <h3>Starter</h3>
          <span class="price">$9</span>
          <ul><li>10 seats</li><li>1 project</li></ul>
        </div>
        <div class="plan">
          <h3>Pro</h3>
          <span class="price">$29</span>
          <ul><li>50 seats</li><li>10 projects</li></ul>
        </div>
        <div class="plan">
          <h3>Enterprise</h3>
          <span class="price">$99</span>
          <ul><li>Unlimited seats</li><li>Unlimited projects</li></ul>
        </div>
      </div>
    </section>
  </body></html>
`;

describe('extractStructured', () => {
  it('returns tables alongside other structured data', () => {
    const html = `
      <html><body>
        <table>
          <thead><tr><th>Name</th><th>Price</th></tr></thead>
          <tbody><tr><td>Widget</td><td>$10</td></tr></tbody>
        </table>
      </body></html>
    `;
    const out = extractStructured(html);
    expect(out.tables).toHaveLength(1);
    expect(out.tables[0].rows[0]).toEqual({ Name: 'Widget', Price: '$10' });
  });

  it('extracts definition-list term/description pairs', () => {
    const html = `
      <html><body>
        <dl>
          <dt>HTTP</dt><dd>HyperText Transfer Protocol</dd>
          <dt>TLS</dt><dd>Transport Layer Security</dd>
        </dl>
      </body></html>
    `;
    const out = extractStructured(html);
    expect(out.definitions).toHaveLength(2);
    expect(out.definitions[0]).toEqual({ term: 'HTTP', description: 'HyperText Transfer Protocol' });
    expect(out.definitions[1].term).toBe('TLS');
  });

  it('joins multiple <dd> for a single <dt>', () => {
    const html = `
      <dl>
        <dt>Term</dt>
        <dd>First meaning</dd>
        <dd>Second meaning</dd>
      </dl>
    `;
    const out = extractStructured(html);
    expect(out.definitions).toHaveLength(1);
    expect(out.definitions[0].description).toContain('First meaning');
    expect(out.definitions[0].description).toContain('Second meaning');
  });

  it('extracts SVG chart hints from title, aria-label, figcaption', () => {
    const html = `
      <html><body>
        <figure>
          <svg aria-label="Revenue by quarter bar chart">
            <title>Quarterly Revenue 2024</title>
          </svg>
          <figcaption>Revenue trended up in Q4</figcaption>
        </figure>
      </body></html>
    `;
    const out = extractStructured(html);
    expect(out.chart_hints).toHaveLength(1);
    const hint = out.chart_hints[0];
    expect(hint.title).toBe('Quarterly Revenue 2024');
    expect(hint.aria_label).toContain('Revenue by quarter');
    expect(hint.figcaption).toContain('Revenue trended');
    expect(hint.type_hint).toBe('chart');
  });

  it('falls back to figure+figcaption when no SVG is present', () => {
    const html = `
      <figure>
        <img src="/chart.png" />
        <figcaption>System architecture diagram overview</figcaption>
      </figure>
    `;
    const out = extractStructured(html);
    expect(out.chart_hints).toHaveLength(1);
    expect(out.chart_hints[0].figcaption).toContain('architecture diagram');
    expect(out.chart_hints[0].type_hint).toBe('diagram');
  });

  it('infers type_hint as graph for network/tree terms', () => {
    const html = `<svg aria-label="Dependency graph visualization"><title>Deps</title></svg>`;
    const out = extractStructured(html);
    expect(out.chart_hints[0].type_hint).toBe('graph');
  });

  it('drops SVGs without any accessible label', () => {
    const html = `<svg><rect /></svg>`;
    const out = extractStructured(html);
    expect(out.chart_hints).toEqual([]);
  });

  it('extracts microdata itemprop key-value pairs', () => {
    const html = `
      <div itemscope itemtype="https://schema.org/Product">
        <span itemprop="name">Thingamajig</span>
        <meta itemprop="sku" content="TH-1234" />
      </div>
    `;
    const out = extractStructured(html);
    const microdata = out.key_value_pairs.filter((p) => p.source === 'microdata');
    expect(microdata.some((p) => p.key === 'name' && p.value === 'Thingamajig')).toBe(true);
    expect(microdata.some((p) => p.key === 'sku' && p.value === 'TH-1234')).toBe(true);
  });

  it('extracts data-label/data-value attribute pairs', () => {
    const html = `
      <div class="row" data-label="RAM" data-value="16 GB"></div>
      <div class="row" data-label="Storage" data-value="512 GB SSD"></div>
    `;
    const out = extractStructured(html);
    const attrs = out.key_value_pairs.filter((p) => p.source === 'data-attr');
    expect(attrs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'RAM', value: '16 GB' }),
        expect.objectContaining({ key: 'Storage', value: '512 GB SSD' }),
      ]),
    );
  });

  it('extracts comparison grid pairs from label/value classes', () => {
    const html = `
      <div class="spec-row">
        <div class="spec-label">Weight</div>
        <div class="spec-value">2.5 kg</div>
      </div>
    `;
    const out = extractStructured(html);
    const grid = out.key_value_pairs.filter((p) => p.source === 'comparison-grid');
    expect(grid.some((p) => p.key === 'Weight' && p.value === '2.5 kg')).toBe(true);
  });

  it('extracts "Key: Value" text patterns from list items', () => {
    const html = `
      <ul>
        <li>Status: Active</li>
        <li>Owner: platform-team</li>
        <li>Not a key-value sentence at all just prose text here.</li>
      </ul>
    `;
    const out = extractStructured(html);
    const text = out.key_value_pairs.filter((p) => p.source === 'text-pattern');
    expect(text.some((p) => p.key === 'Status' && p.value === 'Active')).toBe(true);
    expect(text.some((p) => p.key === 'Owner' && p.value === 'platform-team')).toBe(true);
  });

  it('picks up JSON-LD blocks through to the output', () => {
    const html = `
      <script type="application/ld+json">
      { "@context":"https://schema.org", "@type":"Article", "headline":"Hello" }
      </script>
    `;
    const out = extractStructured(html);
    expect(out.jsonld).toHaveLength(1);
    expect(out.jsonld[0]).toMatchObject({ '@type': 'Article', headline: 'Hello' });
  });

  it('dedupes identical key-value pairs', () => {
    const html = `
      <div itemscope>
        <span itemprop="name">Widget</span>
        <span itemprop="name">Widget</span>
      </div>
    `;
    const out = extractStructured(html);
    const names = out.key_value_pairs.filter((p) => p.key === 'name');
    expect(names).toHaveLength(1);
  });

  it('truncates extremely long values', () => {
    const html = `<dl><dt>X</dt><dd>${'y'.repeat(1000)}</dd></dl>`;
    const out = extractStructured(html);
    expect(out.definitions[0].description.length).toBeLessThanOrEqual(400);
    expect(out.definitions[0].description.endsWith('…')).toBe(true);
  });

  it('returns empty arrays for empty HTML', () => {
    const out = extractStructured('<html><body></body></html>');
    expect(out.tables).toEqual([]);
    expect(out.definitions).toEqual([]);
    expect(out.jsonld).toEqual([]);
    expect(out.chart_hints).toEqual([]);
    expect(out.key_value_pairs).toEqual([]);
  });

  it('surfaces a div/flex pricing grid in .tables while other structures are unaffected', () => {
    const out = extractStructured(THREE_CARD_GRID);
    // The grid must appear as a table.
    expect(out.tables.length).toBeGreaterThanOrEqual(1);
    const grid = out.tables.find((t) => t.rows.length === 3);
    expect(grid).toBeDefined();
    // definitions/chart_hints/jsonld unchanged (no dl/svg/jsonld on the page).
    expect(out.definitions).toEqual([]);
    expect(out.chart_hints).toEqual([]);
    expect(out.jsonld).toEqual([]);
  });

  it('surfaces a repeated-sibling <ol> listing in .tables (list detector merged)', () => {
    // A ranked feed rendered as an <ol> of linked items with metrics — no
    // <table> and no div-grid card shape. The list detector, merged at the
    // structured seam, surfaces it as a table so agents/schema read one row
    // per item with hrefs and typed metrics.
    const html = `<html><body><main><ol class="feed">
      <li><a href="/p/ring-buffer">Lock-free ring buffer</a> <span>184 points</span> <span>57 comments</span></li>
      <li><a href="/p/columnar">Column-oriented storage</a> <span>92 points</span> <span>31 comments</span></li>
      <li><a href="/p/wasm">Compiling to WebAssembly</a> <span>211 points</span> <span>88 comments</span></li>
    </ol></main></body></html>`;
    const out = extractStructured(html);
    const listing = out.tables.find((t) =>
      t.rows.some((r) => Object.values(r).some((v) => v.includes('ring buffer'))),
    );
    expect(listing).toBeDefined();
    expect(listing!.rows).toHaveLength(3);
    expect(listing!.rows[0].href).toBe('/p/ring-buffer');
  });
});

// WHY: div/flex pricing grids are the single biggest Extract miss — a page
// with 3-4 pricing cards in <div>s currently returns tables=[] and the agent
// gets nothing structured. The GATE is >=3 structurally-parallel repeated
// siblings; a [class*=price] token is only a ranking HINT — never sufficient
// alone, or single-product pages would manufacture phantom tables.
describe('detectDivGridTables', () => {
  it('emits exactly one table with one row per card for a 3-card grid', () => {
    const tables = detectDivGridTables(THREE_CARD_GRID);
    expect(tables).toHaveLength(1);
    expect(tables[0].rows).toHaveLength(3);
    // Row segmentation: each card's tier name and its price are co-located in
    // the SAME row (proves per-card grouping, not a flat dump).
    const first = tables[0].rows[0];
    const flat = Object.values(first).join(' ');
    expect(flat).toContain('Starter');
    expect(flat).toContain('$9');
    const last = tables[0].rows[2];
    const flatLast = Object.values(last).join(' ');
    expect(flatLast).toContain('Enterprise');
    expect(flatLast).toContain('$99');
  });

  it('LOAD-BEARING NEGATIVE: a single product block yields ZERO div-grid tables', () => {
    // product-page.html has one class="price", one class="product-rating",
    // one class="feature" — the >=3-sibling gate MUST reject it. If a future
    // change drops that gate (making a [class*=price] token sufficient), this
    // fails immediately.
    const productHtml = readFileSync(
      join(import.meta.dirname, '../../fixtures/extraction/product-page.html'),
      'utf-8',
    );
    const tables = detectDivGridTables(productHtml);
    expect(tables).toEqual([]);
  });

  it('a 2-card grid yields ZERO tables (below the >=3 repetition gate)', () => {
    const twoCard = `
      <div class="tiers">
        <div class="plan"><h3>Free</h3><span class="price">$0</span></div>
        <div class="plan"><h3>Paid</h3><span class="price">$5</span></div>
      </div>
    `;
    expect(detectDivGridTables(twoCard)).toEqual([]);
  });

  it('does not fire on 3 unrelated non-parallel siblings without a card shape', () => {
    // Three <div> siblings that are NOT structurally parallel (different tags/
    // shapes, no repeated price/name pattern) must not be treated as a grid.
    const notAGrid = `
      <div class="container">
        <div class="header">Welcome</div>
        <p>Some prose paragraph describing the product in detail.</p>
        <footer>Copyright 2026</footer>
      </div>
    `;
    expect(detectDivGridTables(notAGrid)).toEqual([]);
  });

  it('does not fire on repeated heading+prose blocks (doc sections / SERP results)', () => {
    // 4 parallel <section> siblings each with a heading but NO price and NO
    // feature list — this is documentation/search-result content, not a
    // pricing grid. Emitting it as a table was the primary overfit trap:
    // requiring price OR (heading AND feature-list) is the guard.
    const docSections = `
      <div class="content">
        <section><h2>Try it</h2><p>Some example prose here.</p></section>
        <section><h2>Syntax</h2><p>More prose describing syntax.</p></section>
        <section><h2>Parameters</h2><p>Even more descriptive prose.</p></section>
        <section><h2>Return value</h2><p>Prose about the return value.</p></section>
      </div>
    `;
    expect(detectDivGridTables(docSections)).toEqual([]);

    const serp = `
      <div class="results">
        <li class="result"><h2><a href="/a">Result One</a></h2></li>
        <li class="result"><h2><a href="/b">Result Two</a></h2></li>
        <li class="result"><h2><a href="/c">Result Three</a></h2></li>
      </div>
    `;
    expect(detectDivGridTables(serp)).toEqual([]);
  });

  it('fires on a numeric spec/comparison card grid without an explicit price', () => {
    // Comparison cards that name a model and list numeric specs (>=2 cells
    // bearing digits/currency) are a real DATA grid — heading + numeric cells
    // qualifies even with no [class*=price] element.
    const specGrid = `
      <div class="specs">
        <div class="card"><h3>Model A</h3><ul><li>16 GB RAM</li><li>512 GB SSD</li></ul></div>
        <div class="card"><h3>Model B</h3><ul><li>32 GB RAM</li><li>1024 GB SSD</li></ul></div>
        <div class="card"><h3>Model C</h3><ul><li>64 GB RAM</li><li>2048 GB SSD</li></ul></div>
      </div>
    `;
    const tables = detectDivGridTables(specGrid);
    expect(tables).toHaveLength(1);
    expect(tables[0].rows).toHaveLength(3);
    expect(tables[0].rows[0].name).toBe('Model A');
  });

  it('does NOT fire on footer link columns (heading + list, but chrome + no data)', () => {
    // The primary over-detection: footer navigation columns are heading + <li>
    // link lists with zero numeric/currency cells, inside a <footer> landmark.
    // They must yield ZERO grid tables — both the chrome-landmark guard and
    // the data-ness requirement reject them.
    const footer = `
      <footer>
        <div class="link-cols">
          <div class="col"><h3>Product</h3><ul><li>Pricing</li><li>Docs</li><li>API</li></ul></div>
          <div class="col"><h3>Company</h3><ul><li>About</li><li>Blog</li><li>Careers</li></ul></div>
          <div class="col"><h3>Resources</h3><ul><li>Guides</li><li>Support</li><li>Status</li></ul></div>
        </div>
      </footer>
    `;
    expect(detectDivGridTables(footer)).toEqual([]);
  });

  it('does NOT fire on a blog-post grid (heading + prose, no data cells)', () => {
    // Repeated <article> cards with a heading and non-numeric text are content,
    // not a data grid — zero numeric/currency cells ⇒ ZERO tables.
    const blog = `
      <div class="posts">
        <article class="post"><h2>First Post</h2><ul><li>tag: javascript</li></ul></article>
        <article class="post"><h2>Second Post</h2><ul><li>tag: typescript</li></ul></article>
        <article class="post"><h2>Third Post</h2><ul><li>tag: golang</li></ul></article>
      </div>
    `;
    expect(detectDivGridTables(blog)).toEqual([]);
  });
});

// WHY (Part B): the card-shape gate accepted a card only via a [class*=price]
// element OR >=2 numeric/currency cells. Real pricing grids whose TOP tiers
// carry a NON-NUMERIC price ("Custom", "Contact sales", "Talk to us") with
// non-numeric feature bullets were missed entirely. The relax adds a third
// signal — a short price-cue phrase in a descendant node — WITHOUT weakening
// the footer/nav/header/blog/FAQ protection.
describe('detectDivGridTables non-numeric price cues (Part B)', () => {
  it('fires on a pricing grid whose cards carry a NON-numeric price cue', () => {
    // No [class*=price], no numeric <li> cells — the only data signal is the
    // "Custom"/"Contact sales"/"Talk to us" price cue. This is the render-class
    // miss the relax targets.
    const grid = `
      <main>
      <h2>Plans</h2>
      <div class="plans">
        <div class="plan"><h3>Team</h3><div class="cost">Custom</div><ul><li>Unlimited seats</li><li>SSO</li></ul></div>
        <div class="plan"><h3>Business</h3><div class="cost">Contact sales</div><ul><li>Advanced security</li><li>SLA</li></ul></div>
        <div class="plan"><h3>Enterprise</h3><div class="cost">Talk to us</div><ul><li>On-prem option</li><li>White glove</li></ul></div>
      </div>
      </main>
    `;
    const tables = detectDivGridTables(grid);
    expect(tables).toHaveLength(1);
    expect(tables[0].rows).toHaveLength(3);
    expect(tables[0].rows[0].name).toBe('Team');
    expect(tables[0].rows[1].name).toBe('Business');
    expect(tables[0].rows[2].name).toBe('Enterprise');
  });

  it('fires on a mixed grid: numeric top tiers + a non-numeric "Custom" tier', () => {
    // The common real shape: paid tiers show $/mo, the top tier shows "Custom".
    // Before the relax only the [class*=price] element saved this; a card whose
    // price lives in a non-price-classed node with a cue must still qualify.
    const grid = `
      <main>
      <h2>Pricing</h2>
      <div class="pricing">
        <div class="tier"><h3>Starter</h3><div class="amount">$0/mo</div><ul><li>1 project</li><li>Community support</li></ul></div>
        <div class="tier"><h3>Growth</h3><div class="amount">$49/mo</div><ul><li>10 projects</li><li>Email support</li></ul></div>
        <div class="tier"><h3>Enterprise</h3><div class="amount">Contact sales</div><ul><li>Unlimited projects</li><li>Dedicated support</li></ul></div>
      </div>
      </main>
    `;
    const tables = detectDivGridTables(grid);
    expect(tables).toHaveLength(1);
    expect(tables[0].rows).toHaveLength(3);
    const names = tables[0].rows.map((r) => r.name);
    expect(names).toEqual(['Starter', 'Growth', 'Enterprise']);
  });

  it('fires on per-seat pricing cues ("$X per seat" / "/user/month")', () => {
    const grid = `
      <main>
      <div class="tiers">
        <div class="tier"><h3>Solo</h3><div class="rate">Custom</div><ul><li>Single user</li></ul></div>
        <div class="tier"><h3>Team</h3><div class="rate">$8 per seat</div><ul><li>Shared workspace</li></ul></div>
        <div class="tier"><h3>Scale</h3><div class="rate">$16 per user / month</div><ul><li>Advanced roles</li></ul></div>
      </div>
      </main>
    `;
    const tables = detectDivGridTables(grid);
    expect(tables).toHaveLength(1);
    expect(tables[0].rows).toHaveLength(3);
    // Per-seat cue is recovered into the price column.
    expect(tables[0].rows[1].price).toContain('per seat');
  });

  // ---- NEGATIVE over-fire probes: the relax must NOT open these up. ----

  it('OVER-FIRE GUARD: a plain nav grid stays ZERO after the relax', () => {
    // Nav link columns say things like "Pricing" / "Contact" as menu items.
    // "Pricing" and "Contact" are NOT price cues; the chrome-landmark guard AND
    // the phrase list (only true call-to-action price phrases) keep this at 0.
    const nav = `
      <nav>
        <div class="menu">
          <div class="group"><h3>Product</h3><ul><li>Pricing</li><li>Features</li><li>Contact</li></ul></div>
          <div class="group"><h3>Company</h3><ul><li>About</li><li>Careers</li><li>Contact us</li></ul></div>
          <div class="group"><h3>Legal</h3><ul><li>Terms</li><li>Privacy</li><li>Cookies</li></ul></div>
        </div>
      </nav>
    `;
    expect(detectDivGridTables(nav)).toEqual([]);
  });

  it('OVER-FIRE GUARD: a footer link grid mentioning "Contact sales" stays ZERO', () => {
    // Footer columns are chrome even if a link literally reads "Contact sales".
    // The <footer> landmark guard must win regardless of the phrase list.
    const footer = `
      <footer>
        <div class="cols">
          <div class="col"><h3>Product</h3><ul><li>Pricing</li><li>Contact sales</li><li>Docs</li></ul></div>
          <div class="col"><h3>Company</h3><ul><li>About</li><li>Blog</li><li>Careers</li></ul></div>
          <div class="col"><h3>Support</h3><ul><li>Help</li><li>Status</li><li>Contact sales</li></ul></div>
        </div>
      </footer>
    `;
    expect(detectDivGridTables(footer)).toEqual([]);
  });

  it('OVER-FIRE GUARD: a blog/FAQ card grid with prose stays ZERO', () => {
    // FAQ/blog cards carry a heading and prose. A price cue must be a SHORT
    // standalone cell, not any prose that happens to contain the words — a FAQ
    // answer that says "contact sales for a custom quote" must not qualify.
    const faq = `
      <div class="faq">
        <div class="q"><h3>How do I upgrade?</h3><p>Open settings and choose a new plan; you can also contact sales for a custom quote at any time.</p></div>
        <div class="q"><h3>Can I cancel?</h3><p>Yes, cancel anytime from the billing page. Talk to us if you need help migrating your data.</p></div>
        <div class="q"><h3>Is there a trial?</h3><p>Every plan includes a free trial. Custom onboarding is available on request.</p></div>
      </div>
    `;
    expect(detectDivGridTables(faq)).toEqual([]);
  });

  it('strips inline <style>/<script> from a price cell (web-component number counter)', () => {
    // Animated number web-components inline a <style> block inside the price
    // node; a naive textContent read leaks that CSS into the price column.
    const grid = `
      <main>
      <div class="pricing">
        <div class="tier"><h3>Free</h3><div class="price">$0<style>:host{display:inline-block}span{will-change:transform}</style></div><ul><li>1 seat</li><li>Community</li></ul></div>
        <div class="tier"><h3>Pro</h3><div class="price">$10<style>:host{display:inline-block}span{will-change:transform}</style></div><ul><li>10 seats</li><li>Email support</li></ul></div>
        <div class="tier"><h3>Scale</h3><div class="price">$40<style>:host{display:inline-block}span{will-change:transform}</style></div><ul><li>Unlimited</li><li>SLA</li></ul></div>
      </div>
      </main>
    `;
    const tables = detectDivGridTables(grid);
    expect(tables).toHaveLength(1);
    expect(tables[0].rows[0].price).toBe('$0');
    expect(tables[0].rows[1].price).toBe('$10');
    for (const r of tables[0].rows) {
      expect(r.price).not.toContain('display');
      expect(r.price).not.toContain('will-change');
    }
  });

  it('OVER-FIRE GUARD: a "per month" cadence WITHOUT a currency does not fire', () => {
    // "posts per month" / "3 times per month" is publishing cadence, not a
    // price. A billing period only counts as a price cue alongside a currency
    // amount, so a card-grid of content stats must stay ZERO.
    const stats = `
      <main>
      <div class="channels">
        <div class="channel"><h3>Newsletter</h3><div class="cadence">4 posts per month</div><ul><li>Curated links</li></ul></div>
        <div class="channel"><h3>Podcast</h3><div class="cadence">2 episodes per month</div><ul><li>Deep dives</li></ul></div>
        <div class="channel"><h3>Blog</h3><div class="cadence">8 articles per month</div><ul><li>How-tos</li></ul></div>
      </div>
      </main>
    `;
    expect(detectDivGridTables(stats)).toEqual([]);
  });

  it('OVER-FIRE GUARD: repeated doc/SERP sections stay ZERO', () => {
    // Re-assert the original doc-section / SERP guard survives the relax.
    const docSections = `
      <div class="content">
        <section><h2>Try it</h2><p>Some example prose here.</p></section>
        <section><h2>Syntax</h2><p>More prose describing syntax.</p></section>
        <section><h2>Parameters</h2><p>Even more descriptive prose.</p></section>
      </div>
    `;
    expect(detectDivGridTables(docSections)).toEqual([]);
  });
});
