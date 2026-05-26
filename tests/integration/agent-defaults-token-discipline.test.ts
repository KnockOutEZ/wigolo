import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleAgent } from '../../src/tools/agent.js';
import type { SearchEngine, RawSearchResult, AgentInput } from '../../src/types.js';
import type { SmartRouter } from '../../src/fetch/router.js';

// Seven distinct sources, each a unique URL — gives the pipeline plenty of
// candidates to fetch. Without a tight default the agent will pull all 7.
const manyResults: RawSearchResult[] = Array.from({ length: 7 }, (_, i) => ({
  title: `Source ${i}`,
  url: `https://example.com/source-${i}`,
  snippet: `Snippet for source ${i} about pricing.`,
  relevance_score: 0.95 - i * 0.05,
  engine: 'integration-stub',
}));

const stubEngine: SearchEngine = {
  name: 'integration-stub',
  search: vi.fn().mockResolvedValue(manyResults),
};

const stubRouter = {
  fetch: vi.fn().mockImplementation((url: string) =>
    Promise.resolve({
      url,
      finalUrl: url,
      html: `<html><head><title>${url}</title></head><body><p>Body for ${url}.</p></body></html>`,
      contentType: 'text/html',
      statusCode: 200,
      method: 'http' as const,
      headers: {},
    }),
  ),
} as unknown as SmartRouter;

describe('agent tool — H3 default max_pages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('caps pages_fetched at the tight default when max_pages is unset', async () => {
    const input: AgentInput = {
      prompt: 'Find pricing across sources',
    };

    const __r = await handleAgent(input, [stubEngine], stubRouter);
    const result = __r.ok ? __r.data : ({ ...__r } as any);

    expect(result.error).toBeUndefined();
    // With the tight default (3), the agent must not fetch more than 3 pages,
    // even though 7 candidate sources are available.
    expect(result.pages_fetched).toBeLessThanOrEqual(3);
  });

  it('honors an explicit max_pages when caller passes one', async () => {
    const input: AgentInput = {
      prompt: 'Find pricing across sources',
      max_pages: 5,
    };

    const __r = await handleAgent(input, [stubEngine], stubRouter);
    const result = __r.ok ? __r.data : ({ ...__r } as any);

    expect(result.error).toBeUndefined();
    expect(result.pages_fetched).toBeLessThanOrEqual(5);
  });
});
