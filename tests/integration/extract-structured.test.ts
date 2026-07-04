import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SmartRouter } from '../../src/fetch/router.js';
import { handleExtract } from '../../src/tools/extract.js';
import { initDatabase, closeDatabase } from '../../src/cache/db.js';
import { resetConfig } from '../../src/config.js';

vi.mock('../../src/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const mockRouter = {
  fetch: vi.fn(),
} as unknown as SmartRouter;

describe('extract mode:structured end-to-end', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, LOG_LEVEL: 'error' };
    resetConfig();
    initDatabase(':memory:');
    vi.clearAllMocks();
  });

  afterEach(() => {
    closeDatabase();
    process.env = originalEnv;
    resetConfig();
  });

  it('returns tables, definitions, jsonld, chart_hints, and key_value_pairs from HTML', async () => {
    const __r_result = await handleExtract(
      {
        html: `<html><body>
          <table><thead><tr><th>Name</th><th>Price</th></tr></thead>
            <tbody><tr><td>Widget</td><td>$9.99</td></tr></tbody></table>
          <dl><dt>Color</dt><dd>Blue</dd></dl>
          <script type="application/ld+json">{"@type":"Product","name":"Widget"}</script>
          <figure><svg><title>Sales Growth Chart</title></svg>
            <figcaption>Annual revenue growth</figcaption></figure>
        </body></html>`,
        mode: 'structured',
      },
      mockRouter,
    );;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.mode).toBe('structured');
    expect(result.error).toBeUndefined();

    const data = result.data as {
      tables: unknown[];
      definitions: unknown[];
      jsonld: unknown[];
      chart_hints: unknown[];
      key_value_pairs: unknown[];
    };

    expect(data.tables.length).toBeGreaterThan(0);
    expect(data.definitions.length).toBeGreaterThan(0);
    expect(data.jsonld.length).toBeGreaterThan(0);
    expect(data.chart_hints.length).toBeGreaterThan(0);
  });

  it('extracts chart hints from SVG title, aria-label, and figcaption', async () => {
    const __r_result = await handleExtract(
      {
        html: `<html><body>
          <figure>
            <svg><title>Performance: Bun 2x faster than Node</title></svg>
            <figcaption>Runtime benchmark results</figcaption>
          </figure>
          <div role="img" aria-label="Memory usage comparison chart">
            <canvas></canvas>
          </div>
        </body></html>`,
        mode: 'structured',
      },
      mockRouter,
    );;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    const data = result.data as { chart_hints: Array<{ title?: string; figcaption?: string; aria_label?: string }> };
    expect(data.chart_hints.length).toBeGreaterThan(0);

    const allText = data.chart_hints.map(h =>
      [h.title, h.figcaption, h.aria_label].filter(Boolean).join(' '),
    ).join(' ');

    expect(allText).toContain('Bun 2x faster');
  });

  it('returns empty structured data for empty HTML', async () => {
    const __r_result = await handleExtract(
      { html: '<html><body></body></html>', mode: 'structured' },
      mockRouter,
    );;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    const data = result.data as { tables: unknown[]; chart_hints: unknown[] };
    expect(data.tables).toEqual([]);
    expect(data.chart_hints).toEqual([]);
  });

  it('surfaces a repeated-sibling <ol>/<ul> listing as a table (list detector at tool boundary)', async () => {
    // The generic list detector is wired into the structured seam, so the
    // extract tool now surfaces an <ol> feed of linked items with metrics as a
    // table — one row per item with anchor hrefs and typed numeric fields.
    const __r_result = await handleExtract(
      {
        html: `<html><body><main><ol class="feed">
          <li><a href="/p/ring-buffer">Lock-free ring buffer</a> <span>184 points</span> <span>57 comments</span></li>
          <li><a href="/p/columnar">Column-oriented storage</a> <span>92 points</span> <span>31 comments</span></li>
          <li><a href="/p/wasm">Compiling to WebAssembly</a> <span>211 points</span> <span>88 comments</span></li>
        </ol></main></body></html>`,
        mode: 'structured',
      },
      mockRouter,
    );;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    const data = result.data as { tables: Array<{ rows: Array<Record<string, string>> }> };
    const listing = data.tables.find((t) =>
      t.rows.some((r) => Object.values(r).some((v) => v.includes('ring buffer'))),
    );
    expect(listing).toBeDefined();
    expect(listing!.rows).toHaveLength(3);
    expect(listing!.rows[0].href).toBe('/p/ring-buffer');
    const nums = Object.values(listing!.rows[0]).filter((v) => /^\d+$/.test(v));
    expect(nums).toContain('184');
  });
});
