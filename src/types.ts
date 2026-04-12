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
  rawBuffer?: Buffer;
  screenshot?: string;
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

export type ExtractorType = 'defuddle' | 'readability' | 'turndown' | 'site-specific' | 'trafilatura';

export type BrowserType = 'chromium' | 'firefox' | 'webkit';

export interface CDPSession {
  id: string;
  url: string;
  title: string;
  webSocketDebuggerUrl: string;
}

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
  // v2 additions — Slice 7:
  include_domains?: string[];
  exclude_domains?: string[];
  from_date?: string;    // ISO date (YYYY-MM-DD)
  to_date?: string;      // ISO date (YYYY-MM-DD)
  category?: 'general' | 'news' | 'code' | 'docs' | 'papers' | 'images';
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
  // v2 additions — Slice 7:
  includeDomains?: string[];
  excludeDomains?: string[];
  fromDate?: string;
  toDate?: string;
  category?: 'general' | 'news' | 'code' | 'docs' | 'papers' | 'images';
}

export interface SearchEngine {
  name: string;
  search(query: string, options?: SearchEngineOptions): Promise<RawSearchResult[]>;
}

// --- Crawl layer types ---

export interface CrawlInput {
  url: string;
  max_depth?: number;
  max_pages?: number;
  strategy?: 'bfs' | 'dfs' | 'sitemap';
  include_patterns?: string[];
  exclude_patterns?: string[];
  use_auth?: boolean;
  extract_links?: boolean;
  max_total_chars?: number;
}

export interface CrawlResultItem {
  url: string;
  title: string;
  markdown: string;
  depth: number;
}

export interface LinkEdge {
  from: string;
  to: string;
}

export interface CrawlOutput {
  pages: CrawlResultItem[];
  total_found: number;
  crawled: number;
  links?: LinkEdge[];
  error?: string;
}

// --- Cache tool types ---

export interface CacheInput {
  query?: string;
  url_pattern?: string;
  since?: string;
  clear?: boolean;
  stats?: boolean;
}

export interface CacheResultItem {
  url: string;
  title: string;
  markdown: string;
  fetched_at: string;
}

export interface CacheStats {
  total_urls: number;
  total_size_mb: number;
  oldest: string;
  newest: string;
}

export interface CacheOutput {
  results?: CacheResultItem[];
  stats?: CacheStats;
  cleared?: number;
  error?: string;
}

// --- Extract tool types ---

export interface ExtractInput {
  url?: string;
  html?: string;
  mode?: 'selector' | 'tables' | 'metadata';
  css_selector?: string;
  multiple?: boolean;
  schema?: Record<string, unknown>; // v2: JSON Schema extraction (accepted, ignored in v1)
}

export interface MetadataData {
  title?: string;
  description?: string;
  author?: string;
  date?: string;
  keywords?: string[];
  og_image?: string;
}

export interface TableData {
  caption?: string;
  headers: string[];
  rows: Array<Record<string, string>>;
}

export interface ExtractOutput {
  data: string | string[] | TableData[] | MetadataData;
  source_url?: string;
  mode: 'selector' | 'tables' | 'metadata';
  error?: string;
}
