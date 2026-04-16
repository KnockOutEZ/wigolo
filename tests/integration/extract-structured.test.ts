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
    const result = await handleExtract(
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
    );

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
    const result = await handleExtract(
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
    );

    const data = result.data as { chart_hints: Array<{ title?: string; figcaption?: string; aria_label?: string }> };
    expect(data.chart_hints.length).toBeGreaterThan(0);

    const allText = data.chart_hints.map(h =>
      [h.title, h.figcaption, h.aria_label].filter(Boolean).join(' '),
    ).join(' ');

    expect(allText).toContain('Bun 2x faster');
  });

  it('returns empty structured data for empty HTML', async () => {
    const result = await handleExtract(
      { html: '<html><body></body></html>', mode: 'structured' },
      mockRouter,
    );

    const data = result.data as { tables: unknown[]; chart_hints: unknown[] };
    expect(data.tables).toEqual([]);
    expect(data.chart_hints).toEqual([]);
  });
});
