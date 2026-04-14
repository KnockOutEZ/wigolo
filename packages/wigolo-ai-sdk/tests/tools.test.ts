import { describe, it, expect, vi } from 'vitest';
import {
  createWebSearchTool,
  createWebFetchTool,
  createWebCrawlTool,
  createFindSimilarTool,
  createResearchTool,
  createAgentTool,
  createWigoloTools,
} from '../src/tools.js';
import type { WigoloMcpClient } from '../src/client.js';

function makeMockClient(response: Record<string, unknown> = {}): WigoloMcpClient {
  return {
    isConnected: true,
    command: 'npx',
    args: ['@staticn0va/wigolo'],
    timeoutMs: 30000,
    connect: vi.fn(),
    disconnect: vi.fn(),
    callTool: vi.fn().mockResolvedValue(response),
  } as unknown as WigoloMcpClient;
}

describe('createWebSearchTool', () => {
  it('returns a tool with description and parameters', () => {
    const client = makeMockClient();
    const tool = createWebSearchTool(client);
    expect(tool.description).toBeDefined();
    expect(tool.description!.length).toBeGreaterThan(10);
    expect(tool.parameters).toBeDefined();
  });

  it('execute calls client.callTool with search', async () => {
    const mockResponse = {
      results: [{ title: 'Test', url: 'https://example.com', snippet: 'snip', relevance_score: 0.9 }],
      query: 'test',
      engines_used: ['duckduckgo'],
      total_time_ms: 500,
    };
    const client = makeMockClient(mockResponse);
    const tool = createWebSearchTool(client);

    const result = await tool.execute!({ query: 'test', max_results: 3 }, { toolCallId: '1', messages: [], abortSignal: new AbortController().signal });
    expect(client.callTool).toHaveBeenCalledWith('search', expect.objectContaining({ query: 'test', max_results: 3 }));
    expect(result.results).toBeDefined();
    expect(result.results.length).toBe(1);
  });

  it('handles errors gracefully', async () => {
    const client = makeMockClient();
    (client.callTool as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Network down'));

    const tool = createWebSearchTool(client);
    const result = await tool.execute!({ query: 'test' }, { toolCallId: '1', messages: [], abortSignal: new AbortController().signal });
    expect(result.error).toContain('Network down');
  });
});

describe('createWebFetchTool', () => {
  it('returns a tool with description and parameters', () => {
    const client = makeMockClient();
    const tool = createWebFetchTool(client);
    expect(tool.description!.length).toBeGreaterThan(10);
    expect(tool.parameters).toBeDefined();
  });

  it('execute calls client.callTool with fetch', async () => {
    const mockResponse = {
      url: 'https://example.com',
      title: 'Example',
      markdown: '# Test',
      metadata: {},
      links: [],
      images: [],
      cached: false,
    };
    const client = makeMockClient(mockResponse);
    const tool = createWebFetchTool(client);

    const result = await tool.execute!({ url: 'https://example.com' }, { toolCallId: '1', messages: [], abortSignal: new AbortController().signal });
    expect(client.callTool).toHaveBeenCalledWith('fetch', expect.objectContaining({ url: 'https://example.com' }));
    expect(result.title).toBe('Example');
  });

  it('passes section parameter', async () => {
    const client = makeMockClient({ url: '', title: '', markdown: '', metadata: {}, links: [], images: [], cached: false });
    const tool = createWebFetchTool(client);

    await tool.execute!({ url: 'https://example.com', section: 'API' }, { toolCallId: '1', messages: [], abortSignal: new AbortController().signal });
    expect(client.callTool).toHaveBeenCalledWith('fetch', expect.objectContaining({ section: 'API' }));
  });

  it('handles errors gracefully', async () => {
    const client = makeMockClient();
    (client.callTool as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Timeout'));

    const tool = createWebFetchTool(client);
    const result = await tool.execute!({ url: 'https://example.com' }, { toolCallId: '1', messages: [], abortSignal: new AbortController().signal });
    expect(result.error).toContain('Timeout');
  });
});

describe('createWebCrawlTool', () => {
  it('returns a tool with description and parameters', () => {
    const client = makeMockClient();
    const tool = createWebCrawlTool(client);
    expect(tool.description!.length).toBeGreaterThan(10);
  });

  it('execute calls client.callTool with crawl', async () => {
    const client = makeMockClient({ pages: [], total_found: 0, crawled: 0 });
    const tool = createWebCrawlTool(client);

    await tool.execute!({ url: 'https://example.com', strategy: 'sitemap', max_pages: 10 }, { toolCallId: '1', messages: [], abortSignal: new AbortController().signal });
    expect(client.callTool).toHaveBeenCalledWith('crawl', expect.objectContaining({
      url: 'https://example.com',
      strategy: 'sitemap',
      max_pages: 10,
    }));
  });
});

describe('createFindSimilarTool', () => {
  it('returns a tool with description and parameters', () => {
    const client = makeMockClient();
    const tool = createFindSimilarTool(client);
    expect(tool.description!.length).toBeGreaterThan(10);
  });

  it('execute calls client.callTool with find_similar', async () => {
    const client = makeMockClient({ results: [], query: '' });
    const tool = createFindSimilarTool(client);

    await tool.execute!({ url: 'https://example.com', max_results: 5 }, { toolCallId: '1', messages: [], abortSignal: new AbortController().signal });
    expect(client.callTool).toHaveBeenCalledWith('find_similar', expect.objectContaining({ url: 'https://example.com' }));
  });
});

describe('createResearchTool', () => {
  it('returns a tool with description and parameters', () => {
    const client = makeMockClient();
    const tool = createResearchTool(client);
    expect(tool.description!.length).toBeGreaterThan(10);
  });

  it('execute calls client.callTool with research', async () => {
    const client = makeMockClient({ report: '', sources: [] });
    const tool = createResearchTool(client);

    await tool.execute!({ topic: 'TypeScript patterns', max_depth: 3 }, { toolCallId: '1', messages: [], abortSignal: new AbortController().signal });
    expect(client.callTool).toHaveBeenCalledWith('research', expect.objectContaining({ topic: 'TypeScript patterns' }));
  });
});

describe('createAgentTool', () => {
  it('returns a tool with description and parameters', () => {
    const client = makeMockClient();
    const tool = createAgentTool(client);
    expect(tool.description!.length).toBeGreaterThan(10);
  });

  it('execute calls client.callTool with agent', async () => {
    const client = makeMockClient({ answer: '', steps: [] });
    const tool = createAgentTool(client);

    await tool.execute!({ goal: 'Compare React and Vue', max_steps: 5 }, { toolCallId: '1', messages: [], abortSignal: new AbortController().signal });
    expect(client.callTool).toHaveBeenCalledWith('agent', expect.objectContaining({ goal: 'Compare React and Vue' }));
  });
});

describe('createWigoloTools', () => {
  it('returns an object with all 6 tools', () => {
    const client = makeMockClient();
    const tools = createWigoloTools(client);
    expect(tools.webSearch).toBeDefined();
    expect(tools.webFetch).toBeDefined();
    expect(tools.webCrawl).toBeDefined();
    expect(tools.findSimilar).toBeDefined();
    expect(tools.research).toBeDefined();
    expect(tools.agent).toBeDefined();
  });

  it('each tool has description and parameters', () => {
    const client = makeMockClient();
    const tools = createWigoloTools(client);
    for (const [name, tool] of Object.entries(tools)) {
      expect(tool.description, `${name} should have description`).toBeDefined();
      expect(tool.parameters, `${name} should have parameters`).toBeDefined();
    }
  });
});
