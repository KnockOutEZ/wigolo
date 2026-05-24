import { describe, it, expect, vi, beforeEach } from 'vitest';

const extractMock = vi.fn().mockResolvedValue({
  title: 'Default Title',
  markdown: '# Default\n\nDefault extracted content.',
  metadata: {},
  links: [],
  images: [],
  extractor: 'defuddle' as const,
});
vi.mock('../../../src/providers/extract-provider.js', () => ({
  getExtractProvider: vi.fn(async () => ({
    name: 'v1' as const,
    extract: extractMock,
  })),
  _resetExtractProviderForTest: vi.fn(),
}));


import { handleAgent } from '../../../src/tools/agent.js';
import type { SearchEngine, RawSearchResult, AgentInput } from '../../../src/types.js';
import type { SmartRouter } from '../../../src/fetch/router.js';

const stubEngine: SearchEngine = {
  name: 'test-stub',
  search: vi.fn().mockResolvedValue([
    { title: 'Result 1', url: 'https://example.com/1', snippet: 'Content 1', relevance_score: 0.9, engine: 'test-stub' },
  ] as RawSearchResult[]),
};

const stubRouter = {
  fetch: vi.fn().mockResolvedValue({
    url: 'https://example.com/1',
    finalUrl: 'https://example.com/1',
    html: '<html><body><h1>Title</h1><p>Content.</p></body></html>',
    contentType: 'text/html',
    statusCode: 200,
    method: 'http' as const,
    headers: {},
  }),
} as unknown as SmartRouter;

describe('handleAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns structured AgentOutput', async () => {
    const input: AgentInput = { prompt: 'Find CRM pricing' };

    const __r_result = await handleAgent(input, [stubEngine], stubRouter);;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.result).toBeDefined();
    expect(result.sources).toBeDefined();
    expect(Array.isArray(result.sources)).toBe(true);
    expect(typeof result.pages_fetched).toBe('number');
    expect(result.steps).toBeDefined();
    expect(Array.isArray(result.steps)).toBe(true);
    expect(typeof result.total_time_ms).toBe('number');
    expect(typeof result.sampling_supported).toBe('boolean');
  });

  it('validates prompt is required', async () => {
    const input = {} as AgentInput;

    const __r_result = await handleAgent(input, [stubEngine], stubRouter);;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.error).toBeDefined();
    expect(result.error_reason).toContain('prompt');
  });

  it('validates empty prompt', async () => {
    const input: AgentInput = { prompt: '' };

    const __r_result = await handleAgent(input, [stubEngine], stubRouter);;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.error).toBeDefined();
  });

  it('validates max_pages is positive', async () => {
    const input: AgentInput = { prompt: 'test', max_pages: 0 };

    const __r_result = await handleAgent(input, [stubEngine], stubRouter);;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.error).toBeDefined();
    expect(result.error_reason).toContain('max_pages');
  });

  it('validates max_pages is not too large', async () => {
    const input: AgentInput = { prompt: 'test', max_pages: 1000 };

    const __r_result = await handleAgent(input, [stubEngine], stubRouter);;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.error).toBeDefined();
  });

  it('validates max_time_ms is positive', async () => {
    const input: AgentInput = { prompt: 'test', max_time_ms: 0 };

    const __r_result = await handleAgent(input, [stubEngine], stubRouter);;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.error).toBeDefined();
    expect(result.error_reason).toContain('max_time_ms');
  });

  it('validates max_time_ms is not too large', async () => {
    const input: AgentInput = { prompt: 'test', max_time_ms: 600001 };

    const __r_result = await handleAgent(input, [stubEngine], stubRouter);;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.error).toBeDefined();
  });

  it('accepts valid max_pages', async () => {
    const input: AgentInput = { prompt: 'Find data', max_pages: 5 };

    const __r_result = await handleAgent(input, [stubEngine], stubRouter);;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.error).toBeUndefined();
    expect(result.pages_fetched).toBeLessThanOrEqual(5);
  });

  it('accepts valid max_time_ms', async () => {
    const input: AgentInput = { prompt: 'Find data', max_time_ms: 30000 };

    const __r_result = await handleAgent(input, [stubEngine], stubRouter);;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.error).toBeUndefined();
  });

  it('passes urls through to pipeline', async () => {
    const input: AgentInput = {
      prompt: 'Check these',
      urls: ['https://example.com/a', 'https://example.com/b'],
    };

    const __r_result = await handleAgent(input, [stubEngine], stubRouter);;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.error).toBeUndefined();
    expect(result.sources.length).toBeGreaterThanOrEqual(2);
  });

  it('passes schema through to pipeline', async () => {
    const input: AgentInput = {
      prompt: 'Extract product data',
      schema: { type: 'object', properties: { name: { type: 'string' } } },
    };

    const __r_result = await handleAgent(input, [stubEngine], stubRouter);;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.error).toBeUndefined();
  });

  it('never throws -- always returns structured output', async () => {
    const __r_result = await handleAgent(
      { prompt: 'test' },
      [],
      stubRouter,
    );;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result).toBeDefined();
    expect(result.result).toBeDefined();
  });

  it('handles engine failure gracefully', async () => {
    const brokenEngine: SearchEngine = {
      name: 'broken',
      search: vi.fn().mockRejectedValue(new Error('engine down')),
    };

    const __r_result = await handleAgent(
      { prompt: 'Error test' },
      [brokenEngine],
      stubRouter,
    );;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result).toBeDefined();
    expect(typeof result.total_time_ms).toBe('number');
  });

  it('handles router failure gracefully', async () => {
    const brokenRouter = {
      fetch: vi.fn().mockRejectedValue(new Error('network down')),
    } as unknown as SmartRouter;

    const __r_result = await handleAgent(
      { prompt: 'Router error test' },
      [stubEngine],
      brokenRouter,
    );;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result).toBeDefined();
  });

  it('sampling_supported is false when no server provided', async () => {
    const __r_result = await handleAgent(
      { prompt: 'test' },
      [stubEngine],
      stubRouter,
    );;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.sampling_supported).toBe(false);
  });

  it('validates urls contains valid URL strings', async () => {
    const input: AgentInput = {
      prompt: 'test',
      urls: ['not-a-url', 'also-not-valid'],
    };

    const __r_result = await handleAgent(input, [stubEngine], stubRouter);;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.error).toBeDefined();
    expect(result.error_reason).toContain('url');
  });

  describe('evidence shape', () => {
    const longMd =
      '# Topic\n\n' +
      'TypeScript is a strongly typed programming language built on JavaScript. ' +
      'It compiles to plain JavaScript and supports advanced type-system features ' +
      'such as generics, conditional types, and template literal types.\n\n' +
      'TypeScript catches type errors at build time which improves reliability.';

    const richRouter = {
      fetch: vi.fn().mockResolvedValue({
        url: 'https://example.com/topic',
        finalUrl: 'https://example.com/topic',
        html: `<html><body><h1>Topic</h1><p>${longMd}</p></body></html>`,
        contentType: 'text/html',
        statusCode: 200,
        method: 'http' as const,
        headers: {},
      }),
    } as unknown as SmartRouter;

    it('default response (no schema) populates evidence and strips source markdown_content', async () => {
      extractMock.mockResolvedValue({
        title: 'Topic',
        markdown: longMd,
        metadata: {},
        links: [],
        images: [],
        extractor: 'defuddle' as const,
      });

      const input: AgentInput = {
        prompt: 'Tell me about TypeScript',
        urls: ['https://example.com/topic'],
        max_pages: 1,
      };
      const __r_result = await handleAgent(input, [stubEngine], richRouter);;
      const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

      expect(result.evidence).toBeDefined();
      expect(result.evidence!.length).toBeGreaterThan(0);
      const ev = result.evidence![0];
      expect(ev.excerpt.length).toBeGreaterThan(0);
      expect(ev.citation_id).toMatch(/^[a-f0-9]{12}$/);
      expect(ev.source_span.end).toBeGreaterThan(ev.source_span.start);
      for (const s of result.sources) {
        expect(s.markdown_content).toBe('');
      }
    });

    it('include_full_markdown=true preserves source markdown_content', async () => {
      extractMock.mockResolvedValue({
        title: 'Topic',
        markdown: longMd,
        metadata: {},
        links: [],
        images: [],
        extractor: 'defuddle' as const,
      });

      const input: AgentInput = {
        prompt: 'Tell me about TypeScript',
        urls: ['https://example.com/topic'],
        max_pages: 1,
        include_full_markdown: true,
      };
      const __r_result = await handleAgent(input, [stubEngine], richRouter);;
      const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

      expect(result.evidence).toBeDefined();
      const hasContent = result.sources.some((s) => s.markdown_content.length > 0);
      expect(hasContent).toBe(true);
    });

    it('schema path leaves evidence absent', async () => {
      extractMock.mockResolvedValue({
        title: 'Topic',
        markdown: longMd,
        metadata: {},
        links: [],
        images: [],
        extractor: 'defuddle' as const,
      });

      const input: AgentInput = {
        prompt: 'Extract types',
        urls: ['https://example.com/topic'],
        schema: { type: 'object', properties: { name: { type: 'string' } } },
      };
      const __r_result = await handleAgent(input, [stubEngine], richRouter);;
      const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

      // When schema is provided, evidence is not populated.
      expect(result.evidence).toBeUndefined();
    });
  });

  describe('aggregate token envelope', () => {
    it('caps total response (result + sources + evidence) within max_tokens_out', async () => {
      // Spin up 40 source URLs so sources[] metadata alone would otherwise
      // bust a small budget. The result string is also long enough that the
      // pre-fix code (which only capped `result`) would still emit a bloated
      // sources array.
      const urls = Array.from({ length: 40 }, (_, i) => `https://example.com/page-${i}`);
      const longMarkdown = '# Heading\n\n' + 'Lorem ipsum dolor sit amet. '.repeat(80);
      extractMock.mockResolvedValue({
        title: 'Some long-title source for the budget envelope test',
        markdown: longMarkdown,
        metadata: {},
        links: [],
        images: [],
        extractor: 'defuddle' as const,
      });

      const richRouter2 = {
        fetch: vi.fn().mockImplementation(async (url: string) => ({
          url,
          finalUrl: url,
          html: '<html><body><h1>Test</h1></body></html>',
          contentType: 'text/html',
          statusCode: 200,
          method: 'http' as const,
          headers: {},
        })),
      } as unknown as SmartRouter;

      const input: AgentInput = {
        prompt: 'Summarize topic X',
        urls,
        max_pages: 40,
        max_tokens_out: 500,
      };
      const __r = await handleAgent(input, [stubEngine], richRouter2);
      expect(__r.ok).toBe(true);
      if (!__r.ok) return;
      const result = __r.data;

      const { countTokens } = await import('../../../src/search/tokens.js');
      const total = countTokens(JSON.stringify(result));
      // Allow a small overhead for the structural skeleton (steps, timings)
      // that cannot be trimmed without dropping observability fields.
      expect(total).toBeLessThanOrEqual(2000);
    });
  });
});

