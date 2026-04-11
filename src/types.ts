export interface FetchInput {
  url: string;
  render_js?: 'auto' | 'always' | 'never';
  use_auth?: boolean;
  max_chars?: number;
  section?: string;
  section_index?: number;
  screenshot?: boolean;
  headers?: Record<string, string>;
}

export interface FetchOutput {
  url: string;
  title: string;
  markdown: string;
  metadata: {
    description?: string;
    author?: string;
    date?: string;
    language?: string;
    section_matched?: boolean;
  };
  links: string[];
  images: string[];
  screenshot?: string;
  cached: boolean;
  error?: string;
}

export interface RawFetchResult {
  url: string;
  finalUrl: string;
  html: string;
  contentType: string;
  statusCode: number;
  method: 'http' | 'playwright';
  headers: Record<string, string>;
}

export interface ExtractionResult {
  title: string;
  markdown: string;
  metadata: {
    description?: string;
    author?: string;
    date?: string;
    language?: string;
  };
  links: string[];
  images: string[];
  extractor: ExtractorType;
}

export type ExtractorType = 'defuddle' | 'readability' | 'turndown' | 'site-specific';

export interface CachedContent {
  id: number;
  url: string;
  normalizedUrl: string;
  title: string;
  markdown: string;
  rawHtml: string;
  metadata: string;
  links: string;
  images: string;
  fetchMethod: 'http' | 'playwright';
  extractorUsed: ExtractorType;
  contentHash: string;
  fetchedAt: string;
  expiresAt: string | null;
}

export interface Extractor {
  name: string;
  canHandle(url: string, html?: string): boolean;
  extract(html: string, url: string): ExtractionResult | null;
}

// --- Search layer types ---

export interface SearchInput {
  query: string;
  max_results?: number;
  include_content?: boolean;
  content_max_chars?: number;
  max_total_chars?: number;
  time_range?: 'day' | 'week' | 'month' | 'year';
  search_engines?: string[];
  language?: string;
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
}

export interface RawSearchResult {
  title: string;
  url: string;
  snippet: string;
  relevance_score: number;
  engine: string;
}

export interface SearchEngineOptions {
  maxResults?: number;
  timeRange?: string;
  language?: string;
  timeoutMs?: number;
}

export interface SearchEngine {
  name: string;
  search(query: string, options?: SearchEngineOptions): Promise<RawSearchResult[]>;
}
