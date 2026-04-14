import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleAgent } from '../../src/tools/agent.js';
import type { SearchEngine, RawSearchResult, AgentInput } from '../../src/types.js';
import type { SmartRouter } from '../../src/fetch/router.js';

const crmResults: RawSearchResult[] = [
  {
    title: 'Salesforce Pricing 2025',
    url: 'https://salesforce.com/pricing',
    snippet: 'Salesforce offers plans from $25 to $300 per user per month.',
    relevance_score: 0.95,
    engine: 'integration-stub',
  },
  {
    title: 'HubSpot CRM Pricing',
    url: 'https://hubspot.com/pricing',
    snippet: 'HubSpot offers a free tier and paid plans starting at $45/month.',
    relevance_score: 0.90,
    engine: 'integration-stub',
  },
  {
    title: 'Zoho CRM Plans',
    url: 'https://zoho.com/crm/pricing',
    snippet: 'Zoho CRM starts at $14 per user per month.',
    relevance_score: 0.85,
    engine: 'integration-stub',
  },
];

const stubEngine: SearchEngine = {
  name: 'integration-stub',
  search: vi.fn().mockResolvedValue(crmResults),
};

const htmlPages: Record<string, string> = {
  'https://salesforce.com/pricing': '<html><head><title>Salesforce Pricing</title></head><body><h1>Salesforce Pricing</h1><p class="price">$25-$300/user/month</p><span class="name">Salesforce CRM</span></body></html>',
  'https://hubspot.com/pricing': '<html><head><title>HubSpot Pricing</title></head><body><h1>HubSpot Pricing</h1><p class="price">Free - $3600/month</p><span class="name">HubSpot CRM</span></body></html>',
  'https://zoho.com/crm/pricing': '<html><head><title>Zoho CRM</title></head><body><h1>Zoho CRM</h1><p class="price">$14/user/month</p><span class="name">Zoho CRM</span></body></html>',
};

const stubRouter = {
  fetch: vi.fn().mockImplementation((url: string) => {
    const html = htmlPages[url] ?? '<html><head><title>Page</title></head><body><h1>Page</h1><p>Default content.</p></body></html>';
    return Promise.resolve({
      url,
      finalUrl: url,
      html,
      contentType: 'text/html',
      statusCode: 200,
      method: 'http' as const,
      headers: {},
    });
  }),
} as unknown as SmartRouter;

describe('agent tool integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('full pipeline: prompt -> plan -> search -> fetch -> synthesize', async () => {
    const input: AgentInput = {
      prompt: 'Find pricing for the top CRM tools',
    };

    const result = await handleAgent(input, [stubEngine], stubRouter);

    expect(result.error).toBeUndefined();
    expect(typeof result.result).toBe('string');
    expect((result.result as string).length).toBeGreaterThan(0);
    expect(result.sources.length).toBeGreaterThan(0);
    expect(result.pages_fetched).toBeGreaterThan(0);
    expect(result.steps.length).toBeGreaterThanOrEqual(3);
    expect(result.total_time_ms).toBeGreaterThanOrEqual(0);
    expect(result.sampling_supported).toBe(false);
  });

  it('steps provide full transparency', async () => {
    const input: AgentInput = { prompt: 'Find CRM pricing' };

    const result = await handleAgent(input, [stubEngine], stubRouter);

    const planStep = result.steps.find((s) => s.action === 'plan');
    expect(planStep).toBeDefined();
    expect(planStep!.detail).toContain('searches');
    expect(planStep!.time_ms).toBeGreaterThanOrEqual(0);

    const synthStep = result.steps.find((s) => s.action === 'synthesize');
    expect(synthStep).toBeDefined();
  });

  it('full pipeline with explicit URLs', async () => {
    const input: AgentInput = {
      prompt: 'Compare pricing',
      urls: ['https://salesforce.com/pricing', 'https://hubspot.com/pricing'],
    };

    const result = await handleAgent(input, [stubEngine], stubRouter);

    expect(result.error).toBeUndefined();
    expect(result.sources.length).toBeGreaterThanOrEqual(2);
    const urls = result.sources.map((s) => s.url);
    expect(urls).toContain('https://salesforce.com/pricing');
    expect(urls).toContain('https://hubspot.com/pricing');
  });

  it('full pipeline with schema extraction', async () => {
    const input: AgentInput = {
      prompt: 'Get pricing info',
      schema: {
        type: 'object',
        properties: {
          price: { type: 'string' },
          name: { type: 'string' },
        },
      },
    };

    const result = await handleAgent(input, [stubEngine], stubRouter);

    expect(result.error).toBeUndefined();
    const extractStep = result.steps.find((s) => s.action === 'extract');
    expect(extractStep).toBeDefined();
  });

  it('max_pages limits actual page fetches', async () => {
    const input: AgentInput = {
      prompt: 'Find CRM tools',
      max_pages: 1,
    };

    const result = await handleAgent(input, [stubEngine], stubRouter);

    expect(result.pages_fetched).toBeLessThanOrEqual(1);
  });

  it('sources include URL, title, and content', async () => {
    const input: AgentInput = { prompt: 'CRM data' };

    const result = await handleAgent(input, [stubEngine], stubRouter);

    for (const source of result.sources.filter((s) => s.fetched)) {
      expect(source.url).toBeTruthy();
      expect(typeof source.title).toBe('string');
      expect(source.markdown_content.length).toBeGreaterThan(0);
    }
  });

  it('handles partial failures gracefully', async () => {
    let callIdx = 0;
    const flakeyRouter = {
      fetch: vi.fn().mockImplementation((url: string) => {
        callIdx++;
        if (callIdx % 2 === 0) {
          return Promise.reject(new Error('intermittent'));
        }
        return Promise.resolve({
          url,
          finalUrl: url,
          html: '<html><body><p>OK</p></body></html>',
          contentType: 'text/html',
          statusCode: 200,
          method: 'http' as const,
          headers: {},
        });
      }),
    } as unknown as SmartRouter;

    const input: AgentInput = { prompt: 'Flaky test' };
    const result = await handleAgent(input, [stubEngine], flakeyRouter);

    expect(result.error).toBeUndefined();
    expect(result.result).toBeDefined();
    expect(result.sources.some((s) => s.fetched)).toBe(true);
    expect(result.sources.some((s) => s.fetch_error)).toBe(true);
  });

  it('input validation returns structured errors', async () => {
    const result1 = await handleAgent({ prompt: '' } as AgentInput, [stubEngine], stubRouter);
    expect(result1.error).toBeDefined();

    const result2 = await handleAgent({ prompt: 'test', max_pages: -1 }, [stubEngine], stubRouter);
    expect(result2.error).toBeDefined();

    const result3 = await handleAgent({ prompt: 'test', max_time_ms: -1 }, [stubEngine], stubRouter);
    expect(result3.error).toBeDefined();

    const result4 = await handleAgent({ prompt: 'test', urls: ['bad-url'] }, [stubEngine], stubRouter);
    expect(result4.error).toBeDefined();
  });

  it('result is a string when no schema provided', async () => {
    const input: AgentInput = { prompt: 'Find info' };

    const result = await handleAgent(input, [stubEngine], stubRouter);

    expect(typeof result.result).toBe('string');
    expect((result.result as string).length).toBeGreaterThan(0);
  });

  it('total_time_ms is reasonable', async () => {
    const input: AgentInput = { prompt: 'Quick test' };

    const before = Date.now();
    const result = await handleAgent(input, [stubEngine], stubRouter);
    const after = Date.now();

    expect(result.total_time_ms).toBeGreaterThanOrEqual(0);
    expect(result.total_time_ms).toBeLessThanOrEqual(after - before + 200);
  });
});
