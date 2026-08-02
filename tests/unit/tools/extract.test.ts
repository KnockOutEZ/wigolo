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

import { scrubProviderEnv } from '../../helpers/provider-isolation.js';
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

  it('mode=tables surfaces a div/flex-grid when no <table> markup exists', async () => {
    // extractTables returns [] (no <table>), but the div-grid detector must
    // recover the 3-card pricing grid so tables mode is not empty.
    vi.mocked(extractTables).mockReturnValue([]);
    const gridHtml = `<html><body>
      <div class="tiers">
        <div class="plan"><h3>Starter</h3><span class="price">$9</span></div>
        <div class="plan"><h3>Pro</h3><span class="price">$29</span></div>
        <div class="plan"><h3>Enterprise</h3><span class="price">$99</span></div>
      </div>
    </body></html>`;

    const __r = await handleExtract({ html: gridHtml, mode: 'tables' }, mockRouter());
    expect(__r.ok).toBe(true);
    if (!__r.ok) return;
    const tables = __r.data.data as Array<{ headers: string[]; rows: Record<string, string>[] }>;
    expect(tables.length).toBeGreaterThanOrEqual(1);
    expect(tables[0].rows).toHaveLength(3);
    const flat = tables[0].rows.map((r) => Object.values(r).join(' '));
    expect(flat[0]).toContain('Starter');
    expect(flat[0]).toContain('$9');
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
  // D18: the schema branch prefers the LLM extractor when isLocalLlmEnabled()
  // (->isLlmConfigured(), env-only gate). Scrub provider env so these assert the
  // deterministic extractWithSchema path regardless of ambient provider keys.
  beforeEach(() => {
    scrubProviderEnv();
  });

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
      // Budget-clip must be signaled, and the surviving structure must keep
      // headers + at least one row (never a silent whole-structure drop).
      expect(__r.data.truncated).toBe(true);
      const tables = __r.data.data as Array<{ headers: string[]; rows: unknown[] }>;
      expect(tables.length).toBeGreaterThan(0);
      expect(tables[0].headers.length).toBeGreaterThan(0);
      const keptRows = tables.reduce((n, t) => n + t.rows.length, 0);
      expect(keptRows).toBeGreaterThan(0);
      expect(Array.isArray(__r.data.warnings)).toBe(true);
      expect((__r.data.warnings ?? []).join(' ')).toMatch(/trimmed to fit max_tokens_out/i);
    }
  });

  // Live P0 benchmark repro: a single wide 26-row table under a tight budget
  // used to trim to `data: []` with NO signal. The contract is proportional
  // degradation — keep headers + some rows, flip truncated, and name the drop.
  it('mode=tables: single 26-row table under tight budget keeps headers + some rows and signals', async () => {
    const cell = 'metric value payload '.repeat(6).trim();
    const rows = Array.from({ length: 26 }, (_, i) => ({
      metric: `${cell}-${i}`,
      value: `${cell}-v${i}`,
    }));
    vi.mocked(extractTables).mockReturnValue([
      { caption: 'Benchmark Results', headers: ['metric', 'value'], rows },
    ]);

    const __r = await handleExtract(
      { html: '<html></html>', mode: 'tables', max_tokens_out: 300 },
      mockRouter(),
    );
    expect(__r.ok).toBe(true);
    if (!__r.ok) return;
    const tables = __r.data.data as Array<{
      caption?: string;
      headers: string[];
      rows: unknown[];
    }>;
    expect(tables.length).toBe(1);
    expect(tables[0].headers).toEqual(['metric', 'value']);
    expect(tables[0].caption).toBe('Benchmark Results');
    expect(tables[0].rows.length).toBeGreaterThan(0);
    expect(tables[0].rows.length).toBeLessThan(26);
    expect(__r.data.truncated).toBe(true);
    const warning = (__r.data.warnings ?? []).join(' ');
    expect(warning).toMatch(/kept \d+ of 26 (table )?rows/i);
  });

  it('mode=structured: tight budget partially populates every non-empty array or signals its drop', async () => {
    const filler = 'lorem ipsum dolor sit amet '.repeat(8).trim();
    const structured = {
      tables: [
        {
          caption: 'Pricing',
          headers: ['Plan', 'Price'],
          rows: Array.from({ length: 12 }, (_, i) => ({ Plan: `Tier ${i} ${filler}`, Price: `$${i}` })),
        },
      ],
      definitions: Array.from({ length: 10 }, (_, i) => ({ term: `term ${i}`, description: `${filler} ${i}` })),
      key_value_pairs: Array.from({ length: 10 }, (_, i) => ({ key: `k${i}`, value: `${filler} ${i}`, source: 'text-pattern' as const })),
      jsonld: [],
      chart_hints: [],
    };
    vi.mocked(extractMetadata).mockReturnValue({});
    // structured mode is dispatched through extractStructured — mock it.
    const structuredMod = await import('../../../src/extraction/structured.js');
    vi.spyOn(structuredMod, 'extractStructured').mockReturnValue(structured as any);

    const __r = await handleExtract(
      { html: '<html></html>', mode: 'structured', max_tokens_out: 250 },
      mockRouter(),
    );
    expect(__r.ok).toBe(true);
    if (!__r.ok) return;
    expect(__r.data.truncated).toBe(true);
    const data = __r.data.data as {
      tables: Array<{ headers: string[]; rows: unknown[] }>;
      definitions: unknown[];
      key_value_pairs: unknown[];
    };
    // Empty arrays stay empty and untouched.
    expect((data as any).jsonld).toEqual([]);
    expect((data as any).chart_hints).toEqual([]);
    // No originally-non-empty array vanished silently: each is either
    // partially populated OR its total drop is named in a warning.
    const warnings = (__r.data.warnings ?? []).join(' ');
    for (const [name, arr, orig] of [
      ['tables', data.tables, structured.tables],
      ['definitions', data.definitions, structured.definitions],
      ['key_value_pairs', data.key_value_pairs, structured.key_value_pairs],
    ] as const) {
      if ((arr?.length ?? 0) === 0) {
        expect(warnings.toLowerCase()).toContain(name);
      }
      // when populated, it must be a strict subset (something was dropped overall)
      expect((arr?.length ?? 0)).toBeLessThanOrEqual(orig.length);
    }
    expect(warnings).toMatch(/trimmed to fit max_tokens_out/i);
  });

  it('degenerate budget (max_tokens_out=5) never returns silent data:[] — always signals', async () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ a: `long cell value ${i} `.repeat(4), b: `${i}` }));
    vi.mocked(extractTables).mockReturnValue([
      { caption: 'Wide', headers: ['a', 'b'], rows },
    ]);

    const __r = await handleExtract(
      { html: '<html></html>', mode: 'tables', max_tokens_out: 5 },
      mockRouter(),
    );
    expect(__r.ok).toBe(true);
    if (!__r.ok) return;
    expect(__r.data.truncated).toBe(true);
    expect((__r.data.warnings ?? []).length).toBeGreaterThan(0);
    expect((__r.data.warnings ?? []).join(' ')).toMatch(/trimmed to fit max_tokens_out/i);
  });

  // ---- MUST-NOT-FIRE (negative) ----

  it('mode=tables: no max_tokens_out and under default cap → full rows, no truncated flag, no trim warning', async () => {
    const rows = Array.from({ length: 26 }, (_, i) => ({ metric: `m${i}`, value: `${i}` }));
    vi.mocked(extractTables).mockReturnValue([
      { caption: 'Small', headers: ['metric', 'value'], rows },
    ]);
    const __r = await handleExtract({ html: '<html></html>', mode: 'tables' }, mockRouter());
    expect(__r.ok).toBe(true);
    if (!__r.ok) return;
    const tables = __r.data.data as Array<{ rows: unknown[] }>;
    expect(tables[0].rows.length).toBe(26);
    expect(__r.data.truncated).toBeUndefined();
    const warnings = (__r.data.warnings ?? []).join(' ');
    expect(warnings).not.toMatch(/trimmed to fit max_tokens_out/i);
  });

  it('mode=tables: generous max_tokens_out fitting everything → identical data, no flag, no warning', async () => {
    const rows = Array.from({ length: 26 }, (_, i) => ({ metric: `m${i}`, value: `${i}` }));
    const input = [{ caption: 'Small', headers: ['metric', 'value'], rows }];
    vi.mocked(extractTables).mockReturnValue(input.map((t) => ({ ...t, rows: [...t.rows] })));
    const __r = await handleExtract(
      { html: '<html></html>', mode: 'tables', max_tokens_out: 100000 },
      mockRouter(),
    );
    expect(__r.ok).toBe(true);
    if (!__r.ok) return;
    expect(__r.data.data).toEqual(input);
    expect(__r.data.truncated).toBeUndefined();
    expect(__r.data.warnings).toBeUndefined();
  });

  it('mode=metadata: small payload under budget → untouched, no flag, no warning', async () => {
    vi.mocked(extractMetadata).mockReturnValue({ title: 'Tiny', description: 'ok' });
    vi.mocked(extractJsonLd).mockReturnValue([]);
    const __r = await handleExtract(
      { html: '<html></html>', mode: 'metadata', max_tokens_out: 5000 },
      mockRouter(),
    );
    expect(__r.ok).toBe(true);
    if (!__r.ok) return;
    expect(__r.data.data).toEqual({ title: 'Tiny', description: 'ok' });
    expect(__r.data.truncated).toBeUndefined();
    expect(__r.data.warnings).toBeUndefined();
  });

  it('strings-only payload over budget → string truncated with marker, truncated:true, no array warnings', async () => {
    const long = 'PostgreSQL async I/O detail. '.repeat(400);
    vi.mocked(extractMetadata).mockReturnValue({ title: 'Doc', description: long });
    vi.mocked(extractJsonLd).mockReturnValue([]);
    const __r = await handleExtract(
      { html: '<html></html>', mode: 'metadata', max_tokens_out: 120 },
      mockRouter(),
    );
    expect(__r.ok).toBe(true);
    if (!__r.ok) return;
    const data = __r.data.data as Record<string, unknown>;
    expect(typeof data.description).toBe('string');
    expect((data.description as string).length).toBeLessThan(long.length);
    expect(__r.data.truncated).toBe(true);
    // A string-only trim should not fabricate an array-drop warning.
    const warnings = (__r.data.warnings ?? []).join(' ');
    expect(warnings).not.toMatch(/table rows|key_value_pairs|definitions/i);
  });

  // Perf encoding: clampTablesToChars used to re-serialize the entire tables
  // payload on every pop iteration (O(N²)). With ~150 rows popped that is
  // ~150 full JSON.stringify(tables) calls — easily seconds on real payloads.
  // The fix tracks a running serialized length and only stringifies the
  // single popped element each iteration. We assert call-count is bounded
  // by N + small constant (instead of growing quadratically) by spying on
  // JSON.stringify.
  it('clampTablesToChars: serialized-length tracking keeps stringify O(N)', async () => {
    const { clampTablesToChars } = await import('../../../src/tools/extract.js');
    // Build one table with 200 rows of moderate width so we need many pops
    // to fit a tight cap.
    const cell = 'x'.repeat(50);
    const rows = Array.from({ length: 200 }, (_, i) => ({ a: `${cell}-${i}`, b: cell }));
    const tables = [{ caption: 'big', headers: ['a', 'b'], rows }];

    // Sanity: full payload is well above cap, and ~3/4 of the rows must pop.
    const fullSize = JSON.stringify(tables).length;
    // Cap chosen so roughly ~150 rows get popped.
    const cap = Math.floor(fullSize / 4);

    const originalStringify = JSON.stringify;
    let totalBytesSerialized = 0;
    JSON.stringify = ((value: unknown, ...rest: unknown[]) => {
      const out = (originalStringify as (...a: unknown[]) => string)(value, ...rest);
      totalBytesSerialized += out.length;
      return out;
    }) as typeof JSON.stringify;
    let result: ReturnType<typeof clampTablesToChars>;
    try {
      result = clampTablesToChars(tables, cap);
    } finally {
      JSON.stringify = originalStringify;
    }

    expect(result.truncated).toBe(true);
    const remainingRows = (result.data as Array<{ rows: unknown[] }>)[0].rows.length;
    const poppedRows = 200 - remainingRows;
    expect(poppedRows).toBeGreaterThan(50); // confirm the test actually exercises the trim loop

    // Pre-fix: every loop iteration calls JSON.stringify(tables) on the WHOLE
    //   payload — so total bytes serialized grows as O(N²) (roughly
    //   poppedRows * average_payload_size_during_loop ≈ fullSize * poppedRows / 2).
    // Post-fix: stringify is called once on the full payload up front, then
    //   only on each popped row — total bytes ≈ fullSize + poppedRows * row_size,
    //   which is linear in N.
    // The bound below is set to 3 * fullSize (linear regime + slack); the
    // O(N²) regime explodes well past it for our 200-row payload.
    expect(totalBytesSerialized).toBeLessThanOrEqual(fullSize * 3);

    // Final payload should still be at or below the cap (soft target — the
    // running-size accounting is approximate, so accept small overshoot).
    const finalSize = originalStringify(result.data).length;
    expect(finalSize).toBeLessThanOrEqual(cap + 32);
  });
});

// brand mode is dispatched via extractBrandAsync, which fetches
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

describe('handleExtract — source-aware SSRF guard (P6-a exfil leg)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCachedContent).mockReturnValue(null);
    vi.mocked(isExpired).mockReturnValue(false);
  });

  it('threads source=human into router.fetch on the standard path (human entry may reach localhost)', async () => {
    const router = mockRouter();
    await handleExtract({ url: 'http://localhost:3000/', mode: 'metadata' }, router as any, 'human');
    expect(router.fetch).toHaveBeenCalledWith('http://localhost:3000/', expect.objectContaining({ source: 'human' }));
  });

  it('blocks an AGENT stealth fetch to cloud-metadata at the handler entry — the router-bypass path is guarded too', async () => {
    const router = mockRouter();
    const r = await handleExtract({ url: 'http://169.254.169.254/latest/meta-data/', execution_mode: 'stealth' }, router as any, 'agent');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('navigation_blocked');
    // the stealth path (fetchWithPlaywright) must NOT have been reached — guarded BEFORE the bypass
    expect(fetchWithPlaywright).not.toHaveBeenCalled();
  });
});
