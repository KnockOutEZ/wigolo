import type { JsonSchema } from './extraction/schema.js';

export type BrowserAction =
  | { type: 'click'; selector: string }
  | { type: 'type'; selector: string; text: string }
  | { type: 'wait'; ms: number }
  | { type: 'wait_for'; selector: string; timeout?: number }
  | { type: 'scroll'; direction: 'down' | 'up'; amount?: number }
  | { type: 'screenshot' };

export interface ActionResult {
  action_index: number;
  type: BrowserAction['type'];
  success: boolean;
  error?: string;
  screenshot?: string;
}

export interface FetchInput {
  url: string;
  render_js?: 'auto' | 'always' | 'never';
  use_auth?: boolean;
  max_chars?: number;
  max_content_chars?: number;
  section?: string;
  section_index?: number;
  screenshot?: boolean;
  headers?: Record<string, string>;
  actions?: BrowserAction[];
  force_refresh?: boolean;
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
    og_image?: string;
    og_type?: string;
    canonical_url?: string;
    keywords?: string[];
    section_matched?: boolean;
  };
  links: string[];
  images: string[];
  screenshot?: string;
  cached: boolean;
  error?: string;
  action_results?: ActionResult[];
  changed?: boolean;
  previous_hash?: string;
  diff_summary?: string;
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
  actionResults?: ActionResult[];
}

export interface ExtractionResult {
  title: string;
  markdown: string;
  metadata: {
    description?: string;
    author?: string;
    date?: string;
    language?: string;
    og_image?: string;
    og_type?: string;
    canonical_url?: string;
    keywords?: string[];
  };
  links: string[];
  images: string[];
  extractor: ExtractorType;
}

export type ExtractorType = 'defuddle' | 'readability' | 'turndown' | 'site-specific' | 'trafilatura';

export type BrowserType = 'chromium' | 'firefox' | 'webkit' | 'lightpanda';

export interface CDPSession {
  id: string;
  url: string;
  title: string;
  webSocketDebuggerUrl: string;
  type?: string;
  devtoolsFrontendUrl?: string;
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

// Provenance source for a single extracted field
export type FieldProvenance = 'json-ld' | 'microdata' | 'rdfa' | 'heuristic';

// One block of structured data found in HTML
export interface StructuredDataResult {
  provenance: 'json-ld' | 'microdata' | 'rdfa';
  type: string;
  fields: Record<string, unknown>;
}

// Schema-mode extraction with provenance
export interface SchemaExtractionResult {
  values: Record<string, unknown>;
  provenance: Record<string, FieldProvenance>;
}

// --- Search layer types ---

export interface SearchInput {
  query: string | string[];
  max_results?: number;
  include_content?: boolean;
  content_max_chars?: number;
  max_content_chars?: number;
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
  format?: 'full' | 'context' | 'answer' | 'highlights' | 'stream_answer';
  max_highlights?: number;
  force_refresh?: boolean;
}

export interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
  markdown_content?: string;
  fetch_failed?: string;
  content_truncated?: boolean;
  relevance_score: number;
  published_date?: string; // ISO date string, when engine provides it
}

export interface SearchOutput {
  results: SearchResultItem[];
  query: string;
  engines_used: string[];
  total_time_ms: number;
  search_time_ms?: number;
  fetch_time_ms?: number;
  error?: string;
  warning?: string;
  context_text?: string;
  queries_executed?: string[];
  answer?: string;
  citations?: Citation[];
  highlights?: Highlight[];
  streaming?: boolean;
}

export interface Highlight {
  text: string;
  source_index: number;
  relevance_score: number;
  source_url: string;
  source_title: string;
}

export interface Citation {
  index: number;
  url: string;
  title: string;
  snippet: string;
}

export interface ProgressUpdate {
  progress: number;
  total?: number;
  message?: string;
}

export type ProgressCallback = (update: ProgressUpdate) => void | Promise<void>;

// --- Research tool types (v3) ---

export interface ResearchInput {
  question: string;
  depth?: 'quick' | 'standard' | 'comprehensive';
  max_sources?: number;
  include_domains?: string[];
  exclude_domains?: string[];
  schema?: Record<string, unknown>;
  stream?: boolean;
}

export interface ResearchSource {
  url: string;
  title: string;
  markdown_content: string;
  relevance_score: number;
  fetched: boolean;
  fetch_error?: string;
}

export interface ResearchOutput {
  report: string;
  citations: Citation[];
  sources: ResearchSource[];
  sub_queries: string[];
  depth: string;
  total_time_ms: number;
  sampling_supported: boolean;
  brief?: ResearchBrief;
  error?: string;
}

export interface CrossReference {
  finding: string;
  source_indices: number[];
  confidence: 'high' | 'medium';
}

export interface ResearchBrief {
  topics: string[];
  highlights: Highlight[];
  key_findings: string[];
  per_source_char_cap: number;
  total_sources_char_cap: number;
  sections: {
    overview: {
      key_findings: string[];
      cross_references: CrossReference[];
    };
    comparison?: {
      entities: string[];
      comparison_points: string[];
    };
    gaps: string[];
  };
  query_type: 'comparison' | 'how-to' | 'concept' | 'general';
}

// --- Agent tool types (v3) ---

export interface AgentInput {
  prompt: string;
  urls?: string[];
  schema?: Record<string, unknown>;
  max_pages?: number;
  max_time_ms?: number;
  stream?: boolean;
}

export interface AgentSource {
  url: string;
  title: string;
  markdown_content: string;
  fetched: boolean;
  fetch_error?: string;
}

export interface AgentStep {
  action: 'plan' | 'search' | 'fetch' | 'extract' | 'synthesize';
  detail: string;
  time_ms: number;
}

export interface AgentOutput {
  result: string | Record<string, unknown>;
  sources: AgentSource[];
  pages_fetched: number;
  steps: AgentStep[];
  total_time_ms: number;
  sampling_supported: boolean;
  error?: string;
}

export interface RawSearchResult {
  title: string;
  url: string;
  snippet: string;
  relevance_score: number;
  engine: string;
  published_date?: string; // ISO date string, when engine provides it
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
  strategy?: 'bfs' | 'dfs' | 'sitemap' | 'map';
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

export interface MapOutput {
  urls: string[];
  total_found: number;
  sitemap_found: boolean;
  error?: string;
}

// --- Cache tool types ---

export interface CacheInput {
  query?: string;
  url_pattern?: string;
  since?: string;
  clear?: boolean;
  stats?: boolean;
  check_changes?: boolean;
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
  changes?: ChangeReport[];
}

export interface ChangeReport {
  url: string;
  changed: boolean;
  previous_hash?: string;
  current_hash?: string;
  diff_summary?: string;
  error?: string;
}

// --- Extract tool types ---

export interface ExtractInput {
  url?: string;
  html?: string;
  mode?: 'selector' | 'tables' | 'metadata' | 'schema' | 'structured';
  css_selector?: string;
  multiple?: boolean;
  schema?: JsonSchema;
}

export interface MetadataData {
  title?: string;
  description?: string;
  author?: string;
  date?: string;
  keywords?: string[];
  og_image?: string;
  og_type?: string;
  canonical_url?: string;
  jsonld?: Record<string, unknown>[];
}

export interface TableData {
  caption?: string;
  headers: string[];
  rows: Array<Record<string, string>>;
}

export interface DefinitionPair {
  term: string;
  description: string;
}

export interface ChartHint {
  title?: string;
  aria_label?: string;
  figcaption?: string;
  type_hint?: 'chart' | 'diagram' | 'graph';
}

export interface KeyValuePair {
  key: string;
  value: string;
  source: 'microdata' | 'data-attr' | 'comparison-grid' | 'text-pattern';
}

export interface StructuredData {
  tables: TableData[];
  definitions: DefinitionPair[];
  jsonld: Record<string, unknown>[];
  chart_hints: ChartHint[];
  key_value_pairs: KeyValuePair[];
}

export interface ExtractOutput {
  data: string | string[] | TableData[] | MetadataData | StructuredData | Record<string, unknown>;
  source_url?: string;
  mode: 'selector' | 'tables' | 'metadata' | 'schema' | 'structured';
  error?: string;
}

// --- Find Similar tool types (v3, Slice 23) ---

export interface MatchSignals {
  embedding_rank?: number;
  fts5_rank?: number;
  fused_score: number;
}

export interface FindSimilarResult {
  url: string;
  title: string;
  markdown: string;
  relevance_score: number;
  source: 'cache' | 'search';
  match_signals: MatchSignals;
}

export interface FindSimilarInput {
  url?: string;
  concept?: string;
  max_results?: number;
  include_domains?: string[];
  exclude_domains?: string[];
  include_cache?: boolean;
  include_web?: boolean;
}

export interface FindSimilarOutput {
  results: FindSimilarResult[];
  method: 'hybrid' | 'embedding' | 'fts5' | 'search';
  cache_hits: number;
  search_hits: number;
  embedding_available: boolean;
  cold_start?: string;
  error?: string;
  total_time_ms: number;
}
