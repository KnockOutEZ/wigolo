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
  /** Tavily-canonical alias of how long the request took, ms. */
  response_time_ms?: number;
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
  /** ISO 3166-1 alpha-2 country code (e.g. "us", "gb", "de"). Hint passed to
   * engines that support a geographic boost; not a strict filter. */
  country?: string;
  /** When true, the query is treated as a quoted phrase. Engines that
   * honour `"..."` filter to results containing the exact phrase, and
   * the orchestrator post-filters out any result whose title+snippet
   * does not contain the phrase as a case-insensitive substring. */
  exact_match?: boolean;
  /** When true, the response carries a top-level `images` array aggregated
   * from per-result image hints emitted by engines that expose them. */
  include_images?: boolean;
  /** When true, each result carries a `favicon` URL derived from its host. */
  include_favicon?: boolean;
}

export interface ImageItem {
  url: string;
  alt?: string;
  /** URL of the result the image came from. */
  source_url: string;
}

export interface EngineOutcomeSummary {
  engine: string;
  ok: boolean;
  latency_ms: number;
  result_count: number;
  error?: string;
  skipped?: boolean;
}

export interface EngineTelemetry {
  name: string;
  latency_ms: number;
  result_count: number;
  outcome: 'ok' | 'error' | 'skipped';
  /** Number of this engine's results that survived dedup + filters and
   * landed in the final fused list. */
  dedup_kept: number;
  error?: string;
}

export type FreshnessConfidence =
  | 'extracted'
  | 'inferred-url'
  | 'inferred-html'
  | 'inferred-llm'
  | 'unknown';

export interface FreshnessSignal {
  published_date?: string;
  inferred: boolean;
  confidence: FreshnessConfidence;
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
  /** Per-result freshness signal: extracted date or inferred from URL/HTML
   * patterns, with a confidence tag callers can pivot on. */
  freshness_signal?: FreshnessSignal;
  /** Always emitted by the core path: explainable score breakdown. */
  evidence_score?: EvidenceScore;
  /** Per-host favicon URL, emitted when input.include_favicon is true. */
  favicon?: string;
  /** Carried through from RawSearchResult.image_url so the orchestrator
   * can aggregate top-level images when input.include_images is true. */
  image_url?: string;
  image_alt?: string;
  /** Debug-only — emitted when input.include_engine_outcomes is true. */
  _score_breakdown?: ScoreBreakdown;
}

export interface SearchOutput {
  results: SearchResultItem[];
  query: string;
  engines_used: string[];
  total_time_ms: number;
  /** Tavily-canonical alias of total_time_ms. Always emitted. */
  response_time_ms?: number;
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
  /** Always emitted on the engine-pool path. Richer view of `engines_used`:
   * per-engine name, latency, result count, outcome, and how many of that
   * engine's results survived dedup into the final fused list. */
  engine_telemetry?: EngineTelemetry[];
  /** Set to `quota_exceeded` when format=answer hit a provider quota wall
   * (e.g. gemini free-tier 429) and the result is a heuristic fallback. */
  synthesis_status?: 'quota_exceeded';
  synthesis_provider?: string;
  synthesis_model?: string;
  synthesis_advice?: string;
  /** Only set by the hybrid provider. `null` means hybrid evaluated all
   * fallback signals and none fired (the result is pure core). A string is
   * the `+`-joined names of every signal that fired (e.g.
   * `"include_domains_over_filter+top1_high_score_low_overlap"`); the
   * result merges core + searxng via RRF. Absent on `core`/`searxng` paths. */
  fallback_signal?: string | null;
  /** Emitted only when the query collides with a brand domain in the
   * top-3 results. Carries reason + disambiguation suggestions so callers
   * can pivot to a clearer phrasing. */
  brand_collision_warning?: {
    detected: true;
    reason: string;
    brand_domains_in_top_3: string[];
    suggested_rewrites: string[];
  };
  /** Classifier view of the query — intent, extracted entities, inferred
   * date hint, language, brand-collision risk, and considered rewrites. */
  query_understanding?: QueryUnderstanding;
  /** Top-level image inventory aggregated from per-result image hints when
   * input.include_images is true. Empty array means the request asked for
   * images but no engine surfaced any. */
  images?: ImageItem[];
}

export interface QueryUnderstanding {
  intent: 'general' | 'news' | 'code' | 'docs' | 'papers';
  entities: string[];
  date_hint: { fromDate?: string; toDate?: string } | null;
  language: string;
  is_brand_collision_prone: boolean;
  rewrites: string[];
}

// Wire shape for format=stream_answer (sub-ticket 2.12). The MCP content
// block stays a single JSON text block, but the inner payload is reshaped
// so callers can pattern-match `stream` (the synthesized or heuristic
// answer text) and an optional `notice` (the synthesis warning that used to
// leak as a separate raw text block). All other SearchOutput fields are
// preserved verbatim.
export interface StreamAnswerEnvelope extends Omit<SearchOutput, 'answer' | 'warning'> {
  stream: string;
  notice?: string;
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
  response_time_ms?: number;
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
    gaps: Array<string | { entity: string; reason: string }>;
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
  response_time_ms?: number;
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

export interface EvidenceScore {
  /** 0..1, what callers usually consume. Matches `relevance_score`. */
  final: number;
  components: {
    /** RRF score before any boost (small, ~0.016 range raw). */
    base_rrf: number;
    /** Sentence-embedding cosine vs query when context_rank was applied. */
    context_cosine: number;
    /** Phase 2 #1 domain authority/quality multiplier. */
    domain_quality: number;
    /** Phase 2 #1 lexical alignment of query against title+snippet. */
    lexical_alignment: number;
    /** Recency multiplier applied when the query has temporal intent. */
    recency_boost: number;
    /** Number of engines that surfaced this URL. */
    engine_consensus: number;
  };
  /** One-line human-readable explanation summarizing the breakdown. */
  explanation: string;
}

export interface RawSearchResult {
  title: string;
  url: string;
  snippet: string;
  relevance_score: number;
  engine: string;
  published_date?: string; // ISO date string, when engine provides it
  /** Always populated by the core orchestrator post-rank: explainable
   * per-result evidence score with components + one-line explanation. */
  evidence_score?: EvidenceScore;
  /** Thumbnail/preview image URL surfaced by engines that expose one
   * (e.g. Brave API thumbnail). Aggregated into SearchOutput.images when
   * the caller sets include_images=true. */
  image_url?: string;
  image_alt?: string;
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
  /** ISO 3166-1 alpha-2 country code. Passed to engines that support a
   * geographic boost (Bing `cc=`, DDG `kl=`, Brave `country=`). Lower-case. */
  country?: string;
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
  /** Tavily-canonical alias of how long the request took, ms. */
  response_time_ms?: number;
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
  /** Tavily-canonical alias of how long the request took, ms. */
  response_time_ms?: number;
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
  response_time_ms?: number;
  evidence?: EvidenceItem[];
}
