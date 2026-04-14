/**
 * wigolo-ai-sdk — Vercel AI SDK tools for wigolo.
 *
 * Provides web search, fetch, crawl, find-similar, research, and agent tools
 * for use with the Vercel AI SDK. Tools communicate with the wigolo MCP server
 * via subprocess.
 */

export { WigoloMcpClient, WigoloClientError } from './client.js';
export {
  createWebSearchTool,
  createWebFetchTool,
  createWebCrawlTool,
  createFindSimilarTool,
  createResearchTool,
  createAgentTool,
  createWigoloTools,
} from './tools.js';
export type {
  WigoloClientOptions,
  SearchOutput,
  SearchResultItem,
  FetchOutput,
  FetchMetadata,
  CrawlOutput,
  CrawlResultItem,
} from './types.js';
