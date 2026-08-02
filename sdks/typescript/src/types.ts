/**
 * Request and response types for every tool. Wire field names are snake_case
 * (the SDK posts request objects verbatim); the client methods are camelCase.
 *
 * Response interfaces model the manifest's `responseKeys` as OPTIONAL known
 * fields intersected with an open extras bag (`WithExtras`) so a server that
 * grows a field does not break the client. The known keys are extracted by the
 * `KnownKeys<T>` helper in the type-level drift test, which stays sharp because
 * the extras bag is a separate intersection — not `& Record<string, unknown>`
 * folded into the same object literal.
 */

/** Opaque JSON-serialisable value passed through verbatim (e.g. a JSON Schema). */
export type Json = unknown;

/** Open extras: unknown server-added fields keyed by string. */
export interface Extras {
  [key: string]: unknown;
}

/** A response interface plus an open extras bag, kept as a separate intersection. */
export type WithExtras<T> = T & Extras;

// ---- Shared enums ----

export type SearchDepth = 'ultra-fast' | 'fast' | 'balanced' | 'deep';
export type CrawlStrategy = 'sitemap' | 'bfs' | 'dfs' | 'map';
export type DiffOutput = 'unified' | 'hunks' | 'summary';
export type DiffGranularity = 'line' | 'word' | 'section';
export type ResearchDepth = 'quick' | 'standard' | 'comprehensive';
export type CitationFormat = 'numbered' | 'json' | 'anthropic_tags';
export type TimeRange = 'day' | 'week' | 'month' | 'year';

/** `diff` old-side reference: a URL, inline markdown, or a cached content hash. */
export type DiffOld = { url: string } | { markdown: string } | { content_hash: string };
/** `diff` new-side reference: a URL or inline markdown. */
export type DiffNew = { url: string } | { markdown: string };

// ---- search ----

export interface SearchRequest {
  query: string | string[];
  max_results?: number;
  max_fetches?: number;
  include_content?: boolean;
  content_max_chars?: number;
  max_content_chars?: number;
  max_total_chars?: number;
  time_range?: TimeRange;
  exact_match?: boolean;
  search_engines?: string[];
  language?: string;
  country?: string;
  include_domains?: string[];
  exclude_domains?: string[];
  from_date?: string;
  to_date?: string;
  category?: string;
  format?: string;
  max_highlights?: number;
  force_refresh?: boolean;
  include_favicon?: boolean;
  include_images?: boolean;
  max_tokens_out?: number;
  include_full_markdown?: boolean;
  citation_format?: CitationFormat;
  mode?: string;
  search_depth?: SearchDepth;
  agent_context?: string;
}

export type SearchResponse = WithExtras<{
  results?: unknown[];
  query?: string | string[];
  engines_used?: string[];
  total_time_ms?: number;
  response_time_ms?: number;
  evidence?: unknown[];
  citations?: unknown[];
  highlights?: unknown[];
  answer?: string;
  warning?: string;
  error?: string;
}>;

// ---- fetch ----

export interface FetchRequest {
  url: string;
  render_js?: boolean;
  use_auth?: boolean;
  max_chars?: number;
  max_content_chars?: number;
  section?: string;
  section_index?: number;
  screenshot?: boolean;
  headers?: Record<string, string>;
  force_refresh?: boolean;
  max_tokens_out?: number;
  include_full_markdown?: boolean;
  citation_format?: CitationFormat;
  actions?: unknown[];
  mode?: string;
}

export type FetchResponse = WithExtras<{
  url?: string;
  title?: string;
  markdown?: string;
  metadata?: Record<string, unknown>;
  links?: unknown[];
  images?: unknown[];
  cached?: boolean;
  fetch_method?: string;
  http_status?: number;
  site_data?: unknown;
  evidence?: unknown[];
  response_time_ms?: number;
  error?: string;
}>;

// ---- crawl ----

export interface CrawlRequest {
  url: string;
  max_depth?: number;
  max_pages?: number;
  strategy?: CrawlStrategy;
  include_patterns?: string[];
  exclude_patterns?: string[];
  use_auth?: boolean;
  extract_links?: boolean;
  max_total_chars?: number;
  max_tokens_out?: number;
  include_full_markdown?: boolean;
  citation_format?: CitationFormat;
}

export type CrawlResponse = WithExtras<{
  /** Present for bfs/dfs/sitemap strategies. */
  pages?: unknown[];
  total_found?: number;
  crawled?: number;
  links?: unknown[];
  /** Present for the `map` strategy (which returns no `pages`). */
  urls?: string[];
  sitemap_found?: boolean;
  response_time_ms?: number;
  error?: string;
}>;

// ---- cache ----

export interface CacheRequest {
  query?: string;
  url_pattern?: string;
  since?: string;
  clear?: boolean;
  stats?: boolean;
  check_changes?: boolean;
  mode?: string;
  limit?: number;
  max_tokens_out?: number;
}

export type CacheResponse = WithExtras<{
  results?: unknown[];
  stats?: Record<string, unknown>;
  cleared?: unknown;
  changes?: unknown[];
  error?: string;
}>;

// ---- extract ----

export interface ExtractRequest {
  url?: string;
  html?: string;
  mode?: string;
  css_selector?: string;
  multiple?: boolean;
  schema?: Json;
  named_schema?: string;
  max_tokens_out?: number;
}

export type ExtractResponse = WithExtras<{
  data?: unknown;
  source_url?: string;
  mode?: string;
  warnings?: string[];
  truncated?: boolean;
  response_time_ms?: number;
  error?: string;
}>;

// ---- find_similar ----

export interface FindSimilarRequest {
  url?: string;
  concept?: string;
  max_results?: number;
  include_domains?: string[];
  exclude_domains?: string[];
  include_cache?: boolean;
  include_web?: boolean;
  mode?: string;
  max_tokens_out?: number;
  include_full_markdown?: boolean;
  citation_format?: CitationFormat;
  threshold?: number;
  include_ranking_debug?: boolean;
}

export type FindSimilarResponse = WithExtras<{
  results?: unknown[];
  method?: string;
  cache_hits?: number;
  search_hits?: number;
  embedding_available?: boolean;
  cold_start?: string;
  total_time_ms?: number;
  response_time_ms?: number;
  error?: string;
}>;

// ---- research ----

export interface ResearchRequest {
  question: string;
  depth?: ResearchDepth;
  max_sources?: number;
  include_domains?: string[];
  exclude_domains?: string[];
  schema?: Json;
  /** Accepted by the schema but INERT over this transport (no notification channel). */
  stream?: boolean;
  max_tokens_out?: number;
  include_full_markdown?: boolean;
  citation_format?: CitationFormat;
}

export type ResearchResponse = WithExtras<{
  report?: string;
  citations?: unknown[];
  sources?: unknown[];
  sub_queries?: string[];
  depth?: string;
  total_time_ms?: number;
  sampling_supported?: boolean;
  brief?: unknown;
  response_time_ms?: number;
  error?: string;
}>;

// ---- agent ----

export interface AgentRequest {
  prompt: string;
  urls?: string[];
  schema?: Json;
  max_pages?: number;
  max_time_ms?: number;
  /** Accepted by the schema but INERT over this transport (no notification channel). */
  stream?: boolean;
  max_tokens_out?: number;
  include_full_markdown?: boolean;
  citation_format?: CitationFormat;
}

export type AgentResponse = WithExtras<{
  result?: unknown;
  sources?: unknown[];
  pages_fetched?: number;
  steps?: unknown[];
  total_time_ms?: number;
  sampling_supported?: boolean;
  warning?: string;
  response_time_ms?: number;
  error?: string;
}>;

// ---- diff ----

export interface DiffRequest {
  old?: DiffOld;
  new?: DiffNew;
  output?: DiffOutput;
  granularity?: DiffGranularity;
}

export type DiffResponse = WithExtras<{
  changed?: boolean;
  unified_diff?: string;
  hunks?: unknown[];
  summary?: unknown;
  truncated?: boolean;
}>;

// ---- watch ----

export interface WatchRequest {
  action: string;
  url?: string;
  urls?: string[];
  interval_seconds?: number;
  selector?: string;
  notification?: unknown;
  job_id?: string;
}

export type WatchResponse = WithExtras<{
  job?: unknown;
  jobs?: unknown[];
  changes_since_last?: unknown;
  notice?: string;
}>;

// ---- infrastructure responses ----

/** `/health` payload (200 up / 503 down, same shape). */
export interface HealthResponse {
  status: string;
  /** Search-aggregator sidecar status. */
  searxng: unknown;
  browsers: unknown;
  cache: unknown;
  uptime_seconds: number;
  [key: string]: unknown;
}

/** Per-call knobs applied on top of the client defaults. */
export interface CallOptions {
  /** Effective deadline (ms). Overrides the client and manifest defaults. */
  timeoutMs?: number;
  /** Caller-supplied cancellation signal, combined with the timeout. */
  signal?: AbortSignal;
}
