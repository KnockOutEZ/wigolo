/**
 * TypeScript types for wigolo tool inputs and outputs.
 * Mirrors the types from the main wigolo package.
 */

export interface WigoloClientOptions {
  command?: string;
  args?: string[];
  timeoutMs?: number;
  env?: Record<string, string>;
}

export interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
  markdown_content?: string;
  fetch_failed?: string;
  content_truncated?: boolean;
  relevance_score: number;
}

export interface SearchOutput {
  results: SearchResultItem[];
  query: string;
  engines_used: string[];
  total_time_ms: number;
  error?: string;
  warning?: string;
  context_text?: string;
}

export interface FetchMetadata {
  description?: string;
  author?: string;
  date?: string;
  language?: string;
  section_matched?: boolean;
}

export interface FetchOutput {
  url: string;
  title: string;
  markdown: string;
  metadata: FetchMetadata;
  links: string[];
  images: string[];
  screenshot?: string;
  cached: boolean;
  error?: string;
}

export interface CrawlResultItem {
  url: string;
  title: string;
  markdown: string;
  depth: number;
}

export interface CrawlOutput {
  pages: CrawlResultItem[];
  total_found: number;
  crawled: number;
  error?: string;
}

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

export interface McpToolContent {
  type: 'text';
  text: string;
}

export interface McpToolResult {
  content: McpToolContent[];
  isError?: boolean;
}
