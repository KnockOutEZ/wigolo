import type { JsonSchema } from './extraction/schema.js';

export type Mode = 'cache' | 'default' | 'stealth';
export const MODES: readonly Mode[] = ['cache', 'default', 'stealth'] as const;

export type DeprecatedMode = 'fast' | 'balanced' | 'deep';
export const DEPRECATED_MODES: readonly DeprecatedMode[] = ['fast', 'balanced', 'deep'] as const;

export interface StageError {
  error: string;
  error_reason: string;
  stage: string;
  hint?: string;
}

export type StageResult<T> =
  | { ok: true; data: T }
  | ({ ok: false } & StageError);

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
  max_tokens_out?: number;
  include_full_markdown?: boolean;
  citation_format?: CitationFormat;
  mode?: Mode;
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
  cached_at?: string;
  stale?: boolean;
  js_required?: boolean;
  error?: string;
  action_results?: ActionResult[];
  changed?: boolean;
  previous_hash?: string;
  diff_summary?: string;
  evidence?: EvidenceItem[];
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
  jsRequired?: boolean;
  escalated?: boolean;
  warning?: string;
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

export type ExtractorType = 'defuddle' | 'readability' | 'turndown' | 'site-specific';

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
export type FieldProvenance = 'json-ld' | 'microdata' | 'rdfa' | 'heuristic' | 'llm';

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

/**
 * Optional agent-supplied context that the v1 search pipeline uses to refine
 * ranking and dedup. All fields are advisory — the engine never requires them.
 */
export interface AgentContext {
  /** Surrounding code, prior assistant turn, or task framing. */
  text?: string;
  /** URLs the agent has already seen recently; v1 dedups against these. */
  recent_urls?: string[];
  /** Optional one-line task framing — included in the embedded query if `text` empty. */
  intent?: string;
}

export interface SearchInput {
  query: string | string[];
  max_results?: number;
  include_content?: boolean;
  content_max_chars?: number;
  max_content_chars?: number;
  max_total_chars?: number;
  max_fetches?: number;
  time_range?: 'day' | 'week' | 'month' | 'year';
  search_engines?: string[];
  language?: string;
  // v2 additions — Slice 7:
  include_domains?: string[];
  exclude_domains?: string[];
  from_date?: string;    // ISO date (YYYY-MM-DD)
  to_date?: string;      // ISO date (YYYY-MM-DD)
  category?: 'general' | 'news' | 'code' | 'docs' | 'papers' | 'images';
  format?: 'answer' | 'stream_answer';
  max_highlights?: number;
  force_refresh?: boolean;
  max_tokens_out?: number;
  include_full_markdown?: boolean;
  citation_format?: CitationFormat;
  mode?: Mode;
  agent_context?: AgentContext;
  /** When true, the response carries per-engine timing + result counts under
   * engine_outcomes. Opt-in because the field is debug-shaped and noisy. */
  include_engine_outcomes?: boolean;
}

export interface EngineOutcomeSummary {
  engine: string;
  ok: boolean;
  latency_ms: number;
  result_count: number;
  error?: string;
  skipped?: boolean;
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
  cached?: boolean;
  cached_at?: string;
  stale?: boolean;
  /** Debug-only — emitted when input.include_engine_outcomes is true. */
  _score_breakdown?: ScoreBreakdown;
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
  evidence?: EvidenceItem[];
  citations_xml?: string;
  /** Present only when input.include_engine_outcomes is true and the call
   * went to the engine pool (cache hits don't populate it). */
  engine_outcomes?: EngineOutcomeSummary[];
  /** Set to `quota_exceeded` when format=answer hit a provider quota wall
   * (e.g. gemini free-tier 429) and the result is a heuristic fallback. */
  synthesis_status?: 'quota_exceeded';
  synthesis_provider?: string;
  synthesis_model?: string;
  synthesis_advice?: string;
}

export interface SourceSpan {
  start: number;
  end: number;
}

export interface EvidenceItem {
  title: string;
  url: string;
  section_heading: string | null;
  excerpt: string;
  score: number;
  citation_id: string;
  source_span: SourceSpan;
}

export type CitationFormat = 'numbered' | 'anthropic_tags' | 'json';

export interface Highlight {
  text: string;
  source_index: number;
  relevance_score: number;
  source_url: string;
  source_title: string;
  section_heading?: string | null;
  source_span?: SourceSpan;
}

export interface Citation {
  index: number;
  url: string;
  title: string;
  snippet: string;
  citation_id?: string;
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
  max_tokens_out?: number;
  include_full_markdown?: boolean;
  citation_format?: CitationFormat;
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
  evidence?: EvidenceItem[];
}

export interface CrossReference {
  finding: string;
  source_indices: number[];
  confidence: 'high' | 'medium';
}

export interface CitationGraphEntry {
  claim: string;
  source_indices: number[];
  confidence: 'high' | 'medium' | 'low';
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
  citation_graph?: CitationGraphEntry[];
}

// --- Agent tool types (v3) ---

export interface AgentInput {
  prompt: string;
  urls?: string[];
  schema?: Record<string, unknown>;
  max_pages?: number;
  max_time_ms?: number;
  stream?: boolean;
  max_tokens_out?: number;
  include_full_markdown?: boolean;
  citation_format?: CitationFormat;
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
  evidence?: EvidenceItem[];
  warning?: string;
}

export interface ScoreBreakdown {
  base: number;
  domain_quality: number;
  lexical_alignment: number;
  final: number;
}

export interface RawSearchResult {
  title: string;
  url: string;
  snippet: string;
  relevance_score: number;
  engine: string;
  published_date?: string; // ISO date string, when engine provides it
  /** Debug-only — present when the core orchestrator was asked to emit
   * score breakdowns (via include_engine_outcomes on the public surface). */
  _score_breakdown?: ScoreBreakdown;
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
  strategy?: 'bfs' | 'dfs' | 'sitemap' | 'map' | 'auto';
  include_patterns?: string[];
  exclude_patterns?: string[];
  use_auth?: boolean;
  extract_links?: boolean;
  max_total_chars?: number;
  max_tokens_out?: number;
  include_full_markdown?: boolean;
  citation_format?: CitationFormat;
}

export interface CrawlResultItem {
  url: string;
  title: string;
  markdown: string;
  depth: number;
  evidence?: EvidenceItem[];
  excerpt?: string;
}

export interface LinkEdge {
  from: string;
  to: string;
}

export interface CrawlOutput {
  pages: CrawlResultItem[];
  total_found: number;
  crawled: number;
  /** Pages fetched but excluded from `pages` due to max_total_chars budget. */
  dropped_over_budget?: number;
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
  /**
   * Search strategy when `query` is provided:
   *   - 'fts'    (default) keyword-only BM25 over FTS5
   *   - 'hybrid' BM25 + semantic vector search fused with reciprocal rank fusion
   * Hybrid mode requires the sqlite-vec extension and a populated embedding
   * index; on miss it transparently falls back to 'fts'.
   */
  mode?: 'fts' | 'hybrid';
  limit?: number;
  max_tokens_out?: number;
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

export type NamedSchemaType =
  | 'Article'
  | 'Recipe'
  | 'Product'
  | 'CodeSnippet'
  | 'Paper'
  | 'EventListing';

export interface ExtractInput {
  url?: string;
  html?: string;
  mode?: 'selector' | 'tables' | 'metadata' | 'schema' | 'structured';
  css_selector?: string;
  multiple?: boolean;
  schema?: JsonSchema;
  named_schema?: NamedSchemaType;
  execution_mode?: Mode;
  max_tokens_out?: number;
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
  warnings?: string[];
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
  mode?: 'auto' | 'cache' | 'web-expansion' | 'crawl-rank';
  max_tokens_out?: number;
  include_full_markdown?: boolean;
  citation_format?: CitationFormat;
}

export interface FindSimilarOutput {
  results: FindSimilarResult[];
  method: 'hybrid' | 'embedding' | 'fts5' | 'search';
  cache_hits: number;
  search_hits: number;
  embedding_available: boolean;
  cold_start?: string;
  cache_seeded?: boolean;
  error?: string;
  total_time_ms: number;
  evidence?: EvidenceItem[];
}
