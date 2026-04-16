import { describe, it, expect } from 'vitest';
import { extractStructured } from '../../../src/extraction/structured.js';

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
});
