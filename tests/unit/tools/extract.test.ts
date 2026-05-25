import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RawFetchResult } from '../../../src/types.js';

vi.mock('../../../src/extraction/extract.js', () => ({
  extractMetadata: vi.fn(),
  extractSelector: vi.fn(),
  extractTables: vi.fn(),
}));

vi.mock('../../../src/extraction/schema.js', () => ({
  extractWithSchema: vi.fn(),
}));

vi.mock('../../../src/extraction/jsonld.js', () => ({
  extractJsonLd: vi.fn().mockReturnValue([]),
}));

vi.mock('../../../src/cache/store.js', () => ({
  getCachedContent: vi.fn(),
  isExpired: vi.fn(),
}));

vi.mock('../../../src/fetch/playwright-tier.js', () => ({
  fetchWithPlaywright: vi.fn(),
}));

vi.mock('../../../src/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { handleExtract } from '../../../src/tools/extract.js';
import { extractMetadata, extractSelector, extractTables } from '../../../src/extraction/extract.js';
import { getCachedContent, isExpired } from '../../../src/cache/store.js';
import { extractWithSchema } from '../../../src/extraction/schema.js';
import { extractJsonLd } from '../../../src/extraction/jsonld.js';
import { fetchWithPlaywright } from '../../../src/fetch/playwright-tier.js';

function mockRouter(html = '<html><body>Hello</body></html>') {
  return {
    fetch: vi.fn().mockResolvedValue({
      url: 'https://example.com',
      finalUrl: 'https://example.com',
      html,
      contentType: 'text/html',
      statusCode: 200,
      method: 'http' as const,
      headers: {},
    } satisfies RawFetchResult),
    getDomainStats: vi.fn(),
  };
}

describe('handleExtract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCachedContent).mockReturnValue(null);
    vi.mocked(isExpired).mockReturnValue(false);
  });

  it('returns error when neither url nor html provided', async () => {
    const __r_result = await handleExtract({}, mockRouter());;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);
    expect(result.error_reason).toBe('Either url or html must be provided');
  });

  it('returns error when mode=selector but no css_selector', async () => {
    const __r_result = await handleExtract(
      { html: '<html></html>', mode: 'selector' },
      mockRouter(),
    );;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);
    expect(result.error_reason).toBe('css_selector is required when mode is "selector"');
  });

  it('uses metadata mode by default', async () => {
    vi.mocked(extractMetadata).mockReturnValue({ title: 'Test' });

    const __r_result = await handleExtract(
      { html: '<html><head><title>Test</title></head></html>' },
      mockRouter(),
    );;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.mode).toBe('metadata');
    expect(extractMetadata).toHaveBeenCalledOnce();
  });

  it('fetches URL when url provided', async () => {
    vi.mocked(extractMetadata).mockReturnValue({ title: 'Fetched' });
    const router = mockRouter();

    const __r_result = await handleExtract({ url: 'https://example.com' }, router);;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(router.fetch).toHaveBeenCalledWith('https://example.com', expect.any(Object));
    expect(result.source_url).toBe('https://example.com');
  });

  it('uses provided html when no url', async () => {
    vi.mocked(extractMetadata).mockReturnValue({ title: 'Direct' });
    const router = mockRouter();

    const __r_result = await handleExtract(
      { html: '<html><head><title>Direct</title></head></html>' },
      router,
    );;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(router.fetch).not.toHaveBeenCalled();
    expect(result.source_url).toBeUndefined();
  });

  it('prefers url over html when both provided', async () => {
    vi.mocked(extractMetadata).mockReturnValue({ title: 'From URL' });
    const router = mockRouter();

    await handleExtract(
      { url: 'https://example.com', html: '<html>ignored</html>' },
      router,
    );

    expect(router.fetch).toHaveBeenCalled();
  });

  it('uses cached HTML when available for URL', async () => {
    vi.mocked(getCachedContent).mockReturnValue({
      id: 1,
      url: 'https://example.com',
      normalizedUrl: 'https://example.com',
      title: 'Cached',
      markdown: '',
      rawHtml: '<html><head><title>Cached</title></head></html>',
      metadata: '{}',
      links: '[]',
      images: '[]',
      fetchMethod: 'http',
      extractorUsed: 'defuddle',
      contentHash: 'abc',
      fetchedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    });

    vi.mocked(extractMetadata).mockReturnValue({ title: 'Cached' });
    const router = mockRouter();

    await handleExtract({ url: 'https://example.com' }, router);

    expect(router.fetch).not.toHaveBeenCalled();
    expect(extractMetadata).toHaveBeenCalledWith(
      '<html><head><title>Cached</title></head></html>',
    );
  });

  it('fetches fresh when cache is expired', async () => {
    vi.mocked(getCachedContent).mockReturnValue({
      id: 1,
      url: 'https://example.com',
      normalizedUrl: 'https://example.com',
      title: 'Stale',
      markdown: '',
      rawHtml: '<html><head><title>Stale</title></head></html>',
      metadata: '{}',
      links: '[]',
      images: '[]',
      fetchMethod: 'http',
      extractorUsed: 'defuddle',
      contentHash: 'abc',
      fetchedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    vi.mocked(isExpired).mockReturnValue(true);
    vi.mocked(extractMetadata).mockReturnValue({ title: 'Fresh' });
    const router = mockRouter();

    const __r_result = await handleExtract({ url: 'https://example.com' }, router);;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(router.fetch).toHaveBeenCalled();
    expect(result.data).toEqual({ title: 'Fresh' });
  });

  it('dispatches to extractSelector for mode=selector', async () => {
    vi.mocked(extractSelector).mockReturnValue('matched text');

    const __r_result = await handleExtract(
      { html: '<html><body><p>test</p></body></html>', mode: 'selector', css_selector: 'p' },
      mockRouter(),
    );;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.mode).toBe('selector');
    expect(extractSelector).toHaveBeenCalledWith(expect.any(String), 'p', false);
    expect(result.data).toBe('matched text');
  });

  it('passes multiple=true to extractSelector', async () => {
    vi.mocked(extractSelector).mockReturnValue(['a', 'b']);

    const __r_result = await handleExtract(
      { html: '<html></html>', mode: 'selector', css_selector: 'p', multiple: true },
      mockRouter(),
    );;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(extractSelector).toHaveBeenCalledWith(expect.any(String), 'p', true);
    expect(result.data).toEqual(['a', 'b']);
  });

  it('dispatches to extractTables for mode=tables', async () => {
    vi.mocked(extractTables).mockReturnValue([{ headers: ['A'], rows: [{ A: '1' }] }]);

    const __r_result = await handleExtract(
      { html: '<html><body><table></table></body></html>', mode: 'tables' },
      mockRouter(),
    );;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.mode).toBe('tables');
    expect(extractTables).toHaveBeenCalledOnce();
  });

  it('ignores schema field when mode is not schema', async () => {
    vi.mocked(extractMetadata).mockReturnValue({ title: 'Test' });

    const __r_result = await handleExtract(
      { html: '<html></html>', mode: 'metadata', schema: { type: 'object' } },
      mockRouter(),
    );;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.error).toBeUndefined();
    expect(result.mode).toBe('metadata');
  });

  it('returns structured error on fetch failure', async () => {
    const router = mockRouter();
    router.fetch.mockRejectedValue(new Error('Network timeout'));

    const __r_result = await handleExtract({ url: 'https://example.com/broken' }, router);;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.error_reason).toBe('Network timeout');
    expect(result.error).toBe('extract_failed');
  });
});

describe('handleExtract mode=schema', () => {
  it('dispatches to extractWithSchema for mode=schema', async () => {
    vi.mocked(extractWithSchema).mockReturnValue({ name: 'Widget', price: '$10' });

    const __r_output = await handleExtract({
      html: '<div class="product-name">Widget</div><span class="price">$10</span>',
      mode: 'schema',
      schema: {
        type: 'object',
        properties: { name: { type: 'string' }, price: { type: 'string' } },
      },
    }, mockRouter());;
    const output = __r_output.ok ? __r_output.data : ({ ...__r_output } as any);

    expect(output.mode).toBe('schema');
    expect(extractWithSchema).toHaveBeenCalledOnce();
    expect((output.data as any).name).toBe('Widget');
  });

  it('returns error when schema mode used without schema property', async () => {
    const __r_output = await handleExtract({
      html: '<p>test</p>',
      mode: 'schema',
    }, mockRouter());;
    const output = __r_output.ok ? __r_output.data : ({ ...__r_output } as any);

    expect(output.error_reason).toContain('schema is required');
  });

  it('returns error when schema mode has empty schema', async () => {
    const __r_output = await handleExtract({
      html: '<p>test</p>',
      mode: 'schema',
      schema: {},
    }, mockRouter());;
    const output = __r_output.ok ? __r_output.data : ({ ...__r_output } as any);

    expect(output.error_reason).toContain('schema');
  });

  it('passes schema through to extractWithSchema', async () => {
    vi.mocked(extractWithSchema).mockReturnValue({ title: 'Test' });
    const schema = {
      type: 'object',
      properties: { title: { type: 'string' } },
    };

    await handleExtract({
      html: '<html><head><title>Test</title></head></html>',
      mode: 'schema',
      schema,
    }, mockRouter());

    expect(extractWithSchema).toHaveBeenCalledWith(
      expect.any(String),
      schema,
    );
  });

  it('fetches URL then extracts with schema', async () => {
    vi.mocked(extractWithSchema).mockReturnValue({ name: 'Fetched' });
    const router = mockRouter();

    const __r_output = await handleExtract({
      url: 'https://example.com/product',
      mode: 'schema',
      schema: { type: 'object', properties: { name: { type: 'string' } } },
    }, router as any);;
    const output = __r_output.ok ? __r_output.data : ({ ...__r_output } as any);

    expect(router.fetch).toHaveBeenCalledWith('https://example.com/product', expect.any(Object));
    expect(output.source_url).toBe('https://example.com');
    expect(output.mode).toBe('schema');
  });

  it('returns empty object on schema extraction error', async () => {
    vi.mocked(extractWithSchema).mockImplementation(() => {
      throw new Error('Parse failed');
    });

    const __r_output = await handleExtract({
      html: '<p>broken</p>',
      mode: 'schema',
      schema: { type: 'object', properties: { x: { type: 'string' } } },
    }, mockRouter());;
    const output = __r_output.ok ? __r_output.data : ({ ...__r_output } as any);

    expect(output.error_reason).toBe('Parse failed');
    expect(output.error).toBe('extract_failed');
  });
});

describe('handleExtract honesty', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCachedContent).mockReturnValue(null);
    vi.mocked(isExpired).mockReturnValue(false);
    vi.mocked(extractTables).mockReturnValue([]);
  });

  it('returns no_tables_detected StageError when zero tables found', async () => {
    const router = mockRouter();
    const __r_out = await handleExtract(
      { url: 'https://example.com', mode: 'tables' } as any,
      router as any,
    );;
    const out = __r_out.ok ? __r_out.data : ({ ...__r_out } as any);
    expect((out as any).error).toBe('no_tables_detected');
    expect((out as any).hint).toMatch(/stealth/);
    expect((out as any).stage).toBe('extract');
  });
});

describe('handleExtract execution_mode:stealth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCachedContent).mockReturnValue(null);
    vi.mocked(isExpired).mockReturnValue(false);
  });

  it('uses fetchWithPlaywright and bypasses cache + router for stealth tables extraction', async () => {
    vi.mocked(fetchWithPlaywright).mockResolvedValue({
      html: '<table><tr><th>a</th></tr><tr><td>1</td></tr></table>',
      text: '',
    } as any);
    vi.mocked(extractTables).mockReturnValue([
      { caption: undefined, headers: ['a'], rows: [{ a: '1' }] },
    ]);

    const router = { fetch: vi.fn(), getDomainStats: vi.fn() };

    const __r_out = await handleExtract(
      { url: 'https://js-page.test/', mode: 'tables', execution_mode: 'stealth' } as any,
      router as any,
    );;
    const out = __r_out.ok ? __r_out.data : ({ ...__r_out } as any);

    expect(getCachedContent).not.toHaveBeenCalled();
    expect(router.fetch).not.toHaveBeenCalled();
    expect(fetchWithPlaywright).toHaveBeenCalledWith('https://js-page.test/');
    expect(Array.isArray(out.data)).toBe(true);
    expect((out.data as any[]).length).toBe(1);
    expect(out.error).toBeUndefined();
  });
});

describe('handleExtract mode=metadata with JSON-LD', () => {
  it('includes JSON-LD data in metadata output', async () => {
    vi.mocked(extractMetadata).mockReturnValue({ title: 'Test' });
    vi.mocked(extractJsonLd).mockReturnValue([
      { '@type': 'Article', headline: 'Test Article' },
    ]);

    const html = `<html><head><title>Test</title>
      <script type="application/ld+json">{"@type": "Article", "headline": "Test Article"}</script>
    </head><body></body></html>`;

    const __r_output = await handleExtract({ html, mode: 'metadata' }, mockRouter());;
    const output = __r_output.ok ? __r_output.data : ({ ...__r_output } as any);
    const data = output.data as any;
    expect(data.jsonld).toHaveLength(1);
    expect(data.jsonld[0]['@type']).toBe('Article');
  });

  it('rejects when both schema and named_schema are provided', async () => {
    const __r_result = await handleExtract(
      {
        html: '<html></html>',
        named_schema: 'Article',
        schema: { type: 'object', properties: { x: { type: 'string' } } },
      },
      mockRouter(),
    );
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);
    expect(result.error_reason).toMatch(/mutually exclusive/);
  });

  it('rejects unknown named_schema values', async () => {
    const __r_result = await handleExtract(
      { html: '<html></html>', named_schema: 'NotAType' as never },
      mockRouter(),
    );
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);
    expect(result.error_reason).toMatch(/Unknown named_schema/);
  });

  it('dispatches named_schema=Article and returns structured data', async () => {
    const articleHtml = `<!doctype html><html><head><title>Hello</title>
      <meta property="article:published_time" content="2024-05-01T10:00:00Z">
    </head><body><article>
      <p>This is a long article about systems engineering and replication.</p>
      <p>It is sufficiently long to satisfy readability heuristics for content.</p>
      <p>Another paragraph adds enough body text to make extraction succeed.</p>
    </article></body></html>`;
    const __r_output = await handleExtract(
      { html: articleHtml, named_schema: 'Article' },
      mockRouter(),
    );
    const output = __r_output.ok ? __r_output.data : ({ ...__r_output } as any);
    expect(output.mode).toBe('schema');
    expect(output.data).toBeTruthy();
    expect(typeof (output.data as any).title === 'string' || (output.data as any).error).toBeTruthy();
  });

  it('returns empty named_schema result with error message when no data found', async () => {
    const __r_output = await handleExtract(
      { html: '<html><body></body></html>', named_schema: 'Recipe' },
      mockRouter(),
    );
    const output = __r_output.ok ? __r_output.data : ({ ...__r_output } as any);
    expect(output.mode).toBe('schema');
    expect(output.error).toMatch(/No Recipe data found/);
  });

  it('omits jsonld key when no JSON-LD blocks found', async () => {
    vi.mocked(extractMetadata).mockReturnValue({ title: 'Plain' });
    vi.mocked(extractJsonLd).mockReturnValue([]);

    const __r_output = await handleExtract({
      html: '<html><head><title>Plain</title></head></html>',
      mode: 'metadata',
    }, mockRouter());;
    const output = __r_output.ok ? __r_output.data : ({ ...__r_output } as any);

    const data = output.data as any;
    expect(data.jsonld).toBeUndefined();
  });

  it('caps mode=tables output to max_tokens_out', async () => {
    const big = (n: number) => 'cell '.repeat(n).trim();
    const fakeTables = Array.from({ length: 20 }, (_, i) => ({
      caption: `Table ${i}`,
      headers: ['col1', 'col2'],
      rows: Array.from({ length: 30 }, () => ({ col1: big(60), col2: big(60) })),
    }));
    vi.mocked(extractTables).mockReturnValue(fakeTables);
    const { countTokens } = await import('../../../src/search/tokens.js');

    const __r = await handleExtract({
      html: '<html></html>',
      mode: 'tables',
      max_tokens_out: 1500,
    }, mockRouter());
    expect(__r.ok).toBe(true);
    if (__r.ok) {
      const tokensUsed = countTokens(JSON.stringify(__r.data.data));
      expect(tokensUsed).toBeLessThanOrEqual(1800);
    }
  });
});

// Slice B2b: brand mode is dispatched via extractBrandAsync, which fetches
// images for palette extraction. The MCP wiring change went from sync
// extractBrand to async extractBrandAsync. This block ensures the
// dispatch in handleExtract still produces a brand envelope and surfaces
// `provenance` (the contract downstream agents depend on).
describe('handleExtract mode=brand', () => {
  it('returns a brand envelope with provenance keys', async () => {
    // CSS-vars-only HTML: synchronous extractor returns colors, palette
    // path stays inert (no fetch). This is the most common live path
    // so we pin it as the canonical mode=brand assertion.
    const html = `<!doctype html><html><head>
      <title>Acme</title>
      <meta property="og:site_name" content="Acme">
      <style>:root { --brand-primary: #635bff; --color-accent: #00d4ff; }</style>
    </head><body></body></html>`;

    const __r = await handleExtract({ html, mode: 'brand' }, mockRouter());
    expect(__r.ok).toBe(true);
    if (!__r.ok) return;
    const data = __r.data.data as Record<string, unknown>;

    expect(__r.data.mode).toBe('brand');
    expect(data.name).toBe('Acme');
    expect(data.primary_colors).toBeDefined();
    expect((data.primary_colors as string[]).length).toBeGreaterThan(0);
    // Provenance object MUST be present — agents key on it.
    const provenance = data.provenance as { colors?: string };
    expect(provenance).toBeDefined();
    expect(provenance.colors).toBe('css-vars');
  });

  it('does not crash when html has no brand signals', async () => {
    // Defensive: an extract call against a bare page should still emit
    // the envelope with `provenance.colors === 'unknown'` and not throw.
    // This is the regression net for the async path failing closed.
    const __r = await handleExtract(
      { html: '<html><body>nothing here</body></html>', mode: 'brand' },
      mockRouter(),
    );
    expect(__r.ok).toBe(true);
    if (!__r.ok) return;
    const data = __r.data.data as Record<string, unknown>;
    const provenance = data.provenance as { colors?: string };
    expect(provenance.colors).toBe('unknown');
  });
});
