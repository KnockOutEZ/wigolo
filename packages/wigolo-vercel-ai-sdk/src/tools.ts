/**
 * Vercel AI SDK tool definitions backed by wigolo.
 *
 * Each function creates a tool definition compatible with the Vercel AI SDK
 * tool() API. The execute function delegates to the WigoloMcpClient.
 */

import { tool } from 'ai';
import { z } from 'zod';
import type { WigoloMcpClient } from './client.js';

export function createWebSearchTool(client: WigoloMcpClient) {
  return tool({
    description:
      'Search the web for information on any topic. Returns titles, URLs, relevance scores, ' +
      'and full extracted markdown content. Supports domain filtering, date ranges, and categories.',
    parameters: z.object({
      query: z.string().describe('Search query — use keywords, not natural language questions'),
      max_results: z.number().int().min(1).max(20).optional().describe('Max results (default 5)'),
      include_domains: z.array(z.string()).optional().describe('Only return results from these domains'),
      exclude_domains: z.array(z.string()).optional().describe('Exclude results from these domains'),
      category: z.enum(['general', 'news', 'code', 'docs', 'papers', 'images']).optional().describe('Search category'),
      from_date: z.string().optional().describe('ISO date — results after this date'),
      to_date: z.string().optional().describe('ISO date — results before this date'),
      time_range: z.enum(['day', 'week', 'month', 'year']).optional().describe('Time range filter'),
      format: z.enum(['full', 'context']).optional().describe("'context' returns a single token-budgeted string for LLM injection"),
    }),
    execute: async (args) => {
      try {
        const params: Record<string, unknown> = { query: args.query };
        if (args.max_results !== undefined) params.max_results = args.max_results;
        if (args.include_domains) params.include_domains = args.include_domains;
        if (args.exclude_domains) params.exclude_domains = args.exclude_domains;
        if (args.category) params.category = args.category;
        if (args.from_date) params.from_date = args.from_date;
        if (args.to_date) params.to_date = args.to_date;
        if (args.time_range) params.time_range = args.time_range;
        if (args.format) params.format = args.format;

        return await client.callTool('search', params);
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  });
}

export function createWebFetchTool(client: WigoloMcpClient) {
  return tool({
    description:
      'Fetch a specific web page and return clean markdown content. Supports JavaScript rendering, ' +
      'section extraction (extract only content under a heading), and authenticated browsing.',
    parameters: z.object({
      url: z.string().url().describe('URL to fetch'),
      section: z.string().optional().describe('Extract content under this heading only'),
      render_js: z.enum(['auto', 'always', 'never']).optional().describe('JS rendering: auto (default), always (force browser), never (HTTP only)'),
      max_chars: z.number().int().min(0).optional().describe('Maximum characters to return'),
      use_auth: z.boolean().optional().describe('Use stored browser session for auth pages'),
    }),
    execute: async (args) => {
      try {
        const params: Record<string, unknown> = { url: args.url };
        if (args.section) params.section = args.section;
        if (args.render_js) params.render_js = args.render_js;
        if (args.max_chars !== undefined) params.max_chars = args.max_chars;
        if (args.use_auth) params.use_auth = args.use_auth;

        return await client.callTool('fetch', params);
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  });
}

export function createWebCrawlTool(client: WigoloMcpClient) {
  return tool({
    description:
      'Crawl a website starting from a URL. Supports BFS, DFS, sitemap (fastest for doc sites), ' +
      'and map (URL-only discovery) strategies. Returns pages with titles and markdown content.',
    parameters: z.object({
      url: z.string().url().describe('Seed URL to start crawling from'),
      strategy: z.enum(['bfs', 'dfs', 'sitemap', 'map']).optional().describe('Crawl strategy (default: bfs). Use sitemap for doc sites, map for URL discovery only'),
      max_depth: z.number().int().min(0).optional().describe('Maximum link depth (default 2)'),
      max_pages: z.number().int().min(1).optional().describe('Maximum pages to crawl (default 20)'),
      include_patterns: z.array(z.string()).optional().describe('URL regex whitelist'),
      exclude_patterns: z.array(z.string()).optional().describe('URL regex blacklist'),
    }),
    execute: async (args) => {
      try {
        const params: Record<string, unknown> = { url: args.url };
        if (args.strategy) params.strategy = args.strategy;
        if (args.max_depth !== undefined) params.max_depth = args.max_depth;
        if (args.max_pages !== undefined) params.max_pages = args.max_pages;
        if (args.include_patterns) params.include_patterns = args.include_patterns;
        if (args.exclude_patterns) params.exclude_patterns = args.exclude_patterns;

        return await client.callTool('crawl', params);
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  });
}

export function createFindSimilarTool(client: WigoloMcpClient) {
  return tool({
    description:
      'Find pages semantically similar to a given URL or text from the local cache. ' +
      'No network calls — uses embedding-based similarity over previously fetched content.',
    parameters: z.object({
      url: z.string().optional().describe('URL to find similar pages for'),
      text: z.string().optional().describe('Text to find similar pages for'),
      max_results: z.number().int().min(1).max(20).optional().describe('Max results (default 5)'),
    }),
    execute: async (args) => {
      try {
        const params: Record<string, unknown> = {};
        if (args.url) params.url = args.url;
        if (args.text) params.text = args.text;
        if (args.max_results !== undefined) params.max_results = args.max_results;

        return await client.callTool('find_similar', params);
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  });
}

export function createResearchTool(client: WigoloMcpClient) {
  return tool({
    description:
      'Deep multi-step research on a topic. Automatically plans search queries, fetches pages, ' +
      'cross-references findings, and returns a structured research report with citations.',
    parameters: z.object({
      topic: z.string().describe('Research topic or question'),
      max_depth: z.number().int().min(1).max(10).optional().describe('Research depth: 2=quick, 3=standard, 5=thorough'),
      max_sources: z.number().int().min(1).optional().describe('Maximum sources to consult'),
    }),
    execute: async (args) => {
      try {
        const params: Record<string, unknown> = { topic: args.topic };
        if (args.max_depth !== undefined) params.max_depth = args.max_depth;
        if (args.max_sources !== undefined) params.max_sources = args.max_sources;

        return await client.callTool('research', params);
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  });
}

export function createAgentTool(client: WigoloMcpClient) {
  return tool({
    description:
      'Autonomous web agent that breaks down complex goals into search/fetch/extract steps. ' +
      'Handles multi-hop reasoning, follow-up queries, and iterative refinement.',
    parameters: z.object({
      goal: z.string().describe('The goal or question to investigate'),
      max_steps: z.number().int().min(1).max(50).optional().describe('Maximum agent steps (default 10)'),
    }),
    execute: async (args) => {
      try {
        const params: Record<string, unknown> = { goal: args.goal };
        if (args.max_steps !== undefined) params.max_steps = args.max_steps;

        return await client.callTool('agent', params);
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  });
}

export function createWigoloTools(client: WigoloMcpClient) {
  return {
    webSearch: createWebSearchTool(client),
    webFetch: createWebFetchTool(client),
    webCrawl: createWebCrawlTool(client),
    findSimilar: createFindSimilarTool(client),
    research: createResearchTool(client),
    agent: createAgentTool(client),
  };
}
