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

/**
 * Which fetch tier produced the response. Tagged on every successful fetch so
 * callers can audit and reason about which path served the bytes:
 *   - 'cache'             : served from the local cache (no tier touched)
 *   - 'http'              : vanilla HTTP tier
 *   - 'tls-impersonation' : Slice D2 TLS-fingerprinted HTTP tier (opt-in)
 *   - 'playwright'        : full browser tier
 */
export type FetchMethod = 'cache' | 'http' | 'tls-impersonation' | 'playwright';

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
  /**
   * Per-site structured JSON, present only when a site extractor matched the
   * URL (e.g. Reddit threads, YouTube watch pages, Amazon product pages).
   * Shape is site-specific — see the corresponding site extractor for the
   * field contract. Sits at top level alongside `evidence` for easy
   * introspection; matches the existing house style (no nested `extra` slot).
   * Absent on generic / non-matched pages so callers can branch on presence.
   */
  site_data?: Record<string, unknown>;
  /** Which tier produced the bytes — see FetchMethod. Always emitted on
   * successful responses; absent only on StageError replies. */
  fetch_method?: FetchMethod;
  /**
   * Upstream HTTP status code. Surfaced so callers can branch on 404 / 403 /
   * 5xx pages that still render usable HTML (a missing-docs landing page is
   * legitimately fetchable but should not be confused with a successful 200
   * by the cache or change-detection layers). Absent on cache hits when the
   * cached row predates the column being persisted.
   */
  http_status?: number;
  /**
   * Slice S7 (C5): partial-success marker. The HTTP fetch returned bytes and
   * the page rendered, but a site-specific extractor (Reddit / Amazon) saw a
   * known anti-bot / not-found challenge body and refused to emit `site_data`.
   * `"blocked"` is the canonical value. Absent when the extractor either
   * matched cleanly (site_data present) or never matched at all (generic
   * page). Callers branch on this instead of treating the fallback markdown
   * as a real site_data payload.
   */
  fetch_failed?: string;
}

export interface RawFetchResult {
  url: string;
  finalUrl: string;
  html: string;
  contentType: string;
  statusCode: number;
  /**
   * Which fetch tier produced the bytes:
   *   - 'http'              : default httpFetch via node fetch
   *   - 'tls-impersonation' : Slice D2 TLS-fingerprinted HTTP tier (opt-in)
   *   - 'playwright'        : full browser fallback
   */
  method: 'http' | 'tls-impersonation' | 'playwright';
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
  /**
   * Structured per-site JSON shape, populated by the v1 routed extractor when
   * a site extractor matches (Reddit / YouTube / Amazon, plus future sites).
   * Survives through `applyPostProcessing` and is surfaced on `FetchOutput.site_data`
   * so callers consume the per-site contract (subreddit/score/comments,
   * video_id/caption_tracks/chapters, asin/price/features) without having to
   * scrape it back out of the markdown body. Shape is per-site — see the
   * extractor source for the field contract.
   */
  site_data?: Record<string, unknown>;
  /**
   * Slice S7 (C5): when a site extractor's URL matched but the response body
   * was a known anti-bot / not-found challenge (Reddit "blocked by network
   * security", Amazon "Page Not Found", etc.), the extractor sets this to the
   * short reason code (e.g. `"blocked"`) instead of producing fake `site_data`.
   * Surfaces on `FetchOutput.fetch_failed` so callers can branch honestly
   * rather than treating the fallback markdown as a real site_data payload.
   */
  site_data_blocked?: string;
}

export type ExtractorType = 'defuddle' | 'readability' | 'turndown' | 'site-specific';

export type BrowserType = 'chromium' | 'firefox' | 'webkit';

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
  /**
   * Upstream HTTP status code captured at fetch time. `null` on rows
   * persisted before the column existed; treated as "unknown" by callers.
   * Cache + change-detection compare status alongside content hash so a
   * 200→404 transition counts as a change even when the body bytes happen
   * to hash identically.
   */
  httpStatus?: number | null;
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
  /** Depth tier:
   *  - 'ultra-fast': cache-only, no engine dispatch (targets ≤ 300ms)
   *  - 'fast': direct engines, no fetch / no rerank / no enrichment (≤ 1s)
   *  - 'balanced' (default): current core behaviour
   *  - 'deep': balanced + full enrichment (slower, more accurate) */
  search_depth?: 'ultra-fast' | 'fast' | 'balanced' | 'deep';
}

export interface ImageItem {
  url: string;
  alt?: string;
  /** URL of the result the image came from. */
  source_url: string;
  /** Optional smaller preview URL when the engine surfaces a separate thumb. */
  thumbnail_url?: string;
  /** Pixel dimensions when the engine reports them. Both must be present
   * together or both absent — partial dimensions are dropped at parse time. */
  width?: number;
  height?: number;
  /** Short engine identifier (e.g. "ddg-image", "brave-image") so callers can
   * surface provenance and de-duplicate across engines. */
  engine?: string;
  /** Original page title hosting the image, when available. */
  title?: string;
}

/**
 * Slice S11a: shape for results returned by image-search engines (DDG Image,
 * Brave Image). Mirrors RawSearchResult on the orchestration plumbing but the
 * `url` field is the SOURCE page (caller can navigate); the `image_url` /
 * `thumbnail_url` fields carry the binary asset URLs.
 */
export interface ImageSearchResult extends RawSearchResult {
  /** Required for image results — the binary image URL. */
  image_url: string;
  /** Smaller preview asset when the engine emits one. */
  thumbnail_url?: string;
  /** Pixel dimensions when the engine reports them. */
  width?: number;
  height?: number;
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
  /** Why the engine was skipped. Only emitted when the circuit breaker
   * rejected dispatch (Slice 4, engine-pool recovery). */
  reason?: 'breaker_open';
  /** Remaining breaker cooldown in ms when reason === 'breaker_open'. */
  cooldown_remaining_ms?: number;
}

/**
 * Slice S1 (M2): top-level engine failure surface. Engine errors used to
 * be visible only when callers opted into `include_engine_outcomes` — that
 * meant a 401 (missing token) or 400 (engine outage) only showed up in
 * debug-shaped telemetry. `engine_warnings` promotes the same information
 * to the default response so every caller sees broken engines without
 * extra flags. For 401s on engines that document an API-key env var, the
 * `hint` field names the var so users can fix the gap quickly.
 */
export interface EngineWarning {
  engine: string;
  /** Stable failure code: 'http_4xx' / 'http_5xx' / 'http_<code>' / generic
   * 'error' for non-HTTP failures (DNS, abort, timeout). */
  code: string;
  /** One-line human-readable explanation drawn from the engine's error. */
  message?: string;
  /** Actionable next step, e.g. "set WIGOLO_GITHUB_TOKEN to lift the 401". */
  hint?: string;
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
  /** Legacy aggregate score in [0, 1]. Equals `evidence_score.final` when
   * the core path emits both; coexists for back-compat with callers that
   * read this field directly. Slice 8 / M13: `relevance_score` and
   * `evidence_score.final` are intentionally NOT unified — `relevance_score`
   * is the flat field every caller has consumed since v0.0.x, while
   * `evidence_score` carries the explainable component breakdown (RRF
   * base + domain quality + lexical alignment + recency + engine consensus
   * + context-cosine). Read `relevance_score` for ranking, read
   * `evidence_score.components.*` to explain WHY a result ranked. */
  relevance_score: number;
  published_date?: string; // ISO date string, when engine provides it
  cached?: boolean;
  cached_at?: string;
  stale?: boolean;
  /** Per-result freshness signal: extracted date or inferred from URL/HTML
   * patterns, with a confidence tag callers can pivot on. */
  freshness_signal?: FreshnessSignal;
  /** Always emitted by the core path: explainable score breakdown. Slice
   * 8 / M13: `.final` mirrors the flat `relevance_score` for back-compat;
   * `.components.*` carries the per-signal breakdown that powers the
   * explanation. Both fields coexist — see `relevance_score` JSDoc. */
  evidence_score?: EvidenceScore;
  /** Per-host favicon URL, emitted when input.include_favicon is true. */
  favicon?: string;
  /** Carried through from RawSearchResult.image_url so the orchestrator
   * can aggregate top-level images when input.include_images is true. */
  image_url?: string;
  image_alt?: string;
  /** Image-search-only: smaller preview URL when an image-search engine
   * surfaces one separately from the full-resolution `image_url`. */
  thumbnail_url?: string;
  /** Image-search-only: pixel width / height when an image-search engine
   * reports them. Both are set together by the orchestrator. */
  width?: number;
  height?: number;
  /** Debug-only — emitted when input.include_engine_outcomes is true. */
  _score_breakdown?: ScoreBreakdown;
}

export interface SearchOutput {
  results: SearchResultItem[];
  query: string;
  /** Semantic view: engines that contributed >= 1 result to the deduped
   * fused list (i.e. "who ended up in the answer"). Empty engines and
   * errored engines are excluded — see `engine_telemetry` for the raw
   * attempt log of every engine that fired. The two arrays answer
   * different questions and intentionally disagree when an engine
   * returned nothing or got fully de-duped out. */
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
  /** Raw attempt log: every engine that was dispatched, regardless of
   * whether it returned results, succeeded, or errored. Each row carries
   * name, latency, result_count, outcome, and `dedup_kept` (how many of
   * that engine's results survived dedup into the final fused list).
   * Distinct from `engines_used`, which is the SEMANTIC view (contributors
   * only, derived from rows where `dedup_kept > 0`). */
  engine_telemetry?: EngineTelemetry[];
  /** Slice S1 (M2): top-level failure surface, always emitted on the
   * engine-pool path (empty array when no engine errored). Promotes
   * `engine_telemetry.outcome === 'error'` entries into a flat list with a
   * stable failure code + optional env-var hint so callers branch on
   * engine health without parsing telemetry. */
  engine_warnings?: EngineWarning[];
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
  /** Set by search_depth=ultra-fast on a cache miss; tells the caller to
   * retry with a higher depth. */
  notice?: string;
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
  intent: 'general' | 'news' | 'code' | 'docs' | 'papers' | 'images';
  entities: string[];
  date_hint: { fromDate?: string; toDate?: string } | null;
  language: string;
  is_brand_collision_prone: boolean;
  rewrites: string[];
  /** Structurally-detected rare/compound tokens (sqlite-vec, vec0, snake_case). */
  compound_terms: string[];
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

export interface RejectedSource {
  url: string;
  reason: 'homepage' | 'serp' | 'social-promo' | 'low-content' | 'low-overlap' | 'negative-score';
  stage: 'url-shape' | 'content-gate' | 'score-floor';
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
  /** Candidates dropped by source validation (homepage/SERP shape or empty
   * content shell), surfaced so drops are auditable, not silently swallowed. */
  rejected_sources?: RejectedSource[];
}

export interface CrossReference {
  finding: string;
  source_indices: number[];
  confidence: 'high' | 'medium';
}

/** A source-quoted comparison tradeoff: the actual sentence from a source that
 * pairs a compared entity with a comparison term, plus the index of the source
 * it came from (0-based into the brief's `fetched` view). Captured instead of a
 * bare keyword so the template renderer can quote a real, cited tradeoff rather
 * than fabricate directionality. */
export interface ComparisonTradeoff {
  text: string;
  source_index: number;
  term: string;
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
      /** Source-quoted tradeoff sentences (entity + comparison term in context)
       * with the index of the source they came from, so a renderer can cite a
       * real tradeoff `[n]` instead of inventing a verdict from bare keywords. */
      tradeoffs: ComparisonTradeoff[];
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
  /** [0, 1] aggregate. Mirrors `SearchResultItem.relevance_score` so a
   * caller can read either field for ranking. Slice 8 / M13: the two
   * fields coexist (relevance_score = legacy flat aggregate;
   * evidence_score.final = same number alongside the component breakdown).
   * Do not unify — both surfaces are still on the API contract. */
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
    /** Cross-encoder relevance (normalised 0-1 over the rerank window).
     * Present only on balanced/deep tiers when the reranker is active. */
    cross_encoder?: number;
    /** Rare/compound-term rank factor applied in the core final-score map.
     * >1 boosts exact-token/phrase matches; <1 damps generic filler. */
    rare_terms?: number;
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
  /** Image-search-only: a smaller preview URL (typically engine-hosted
   * thumbnail). Distinct from `image_url`, which is the full-resolution
   * source. Only set by image-search engines (DDG Image / Brave Image). */
  thumbnail_url?: string;
  /** Image-search-only: pixel width when the engine reports it. */
  width?: number;
  /** Image-search-only: pixel height when the engine reports it. */
  height?: number;
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
  mode?: 'selector' | 'tables' | 'metadata' | 'schema' | 'structured' | 'brand';
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
  mode: 'selector' | 'tables' | 'metadata' | 'schema' | 'structured' | 'brand';
  error?: string;
  warnings?: string[];
  /** Tavily-canonical alias of how long the request took, ms. */
  response_time_ms?: number;
  /** Stub-only marker — present while a mode (currently `'brand'`) is still
   * a slice A1 placeholder and the real extractor hasn't landed yet. */
  notice?: string;
  /** Stub-only marker — names the slice that will complete the surface. */
  slice?: string;
  /** H3: present (true) when the payload was clipped to fit a default cap
   * (e.g. mode='tables' default 30000-char ceiling). Callers can re-issue
   * the call with an explicit max_tokens_out to widen or narrow the cap. */
  truncated?: boolean;
}

// --- Brand extraction ---

import type {
  LogoProvenance,
  ColorsProvenance,
  FontsProvenance,
} from './extraction/brand-provenance.js';

/**
 * Output shape for `extract mode: 'brand'`.
 *
 * Honesty contract (slice 4 / flaw M3):
 *   - `name` is set ONLY when an explicit source emits it (JSON-LD,
 *     og:site_name, heuristic <img alt>). The page <title> tail is NEVER
 *     a name source — it's typically a tagline.
 *   - `logo_url` is set ONLY when a real logo source emits it (JSON-LD
 *     logo, og:logo, heuristic DOM logo). Favicons NEVER promote to
 *     logo_url. The `favicon_url` and `logo_url` fields are independent.
 *
 * Provenance enums (slice 4 / flaw L3): the value space is single-sourced
 * from `src/extraction/brand-provenance.ts`. Add new values THERE first;
 * this type derives from those arrays.
 */
export interface BrandExtractionOutput {
  name?: string;
  tagline?: string;
  description?: string;
  /** URL only — never re-hosted. */
  logo_url?: string;
  favicon_url?: string;
  og_image_url?: string;
  /** Hex codes from CSS vars or palette extraction. */
  primary_colors?: string[];
  fonts?: {
    headings?: string[];
    body?: string[];
  };
  social_links?: {
    twitter?: string;
    github?: string;
    linkedin?: string;
    [platform: string]: string | undefined;
  };
  provenance?: {
    logo?: LogoProvenance;
    colors?: ColorsProvenance;
    fonts?: FontsProvenance;
  };
}

// --- Diff tool (slice A1 placeholder, full impl lands in B1) ---

export type DiffOutputShape = 'unified' | 'hunks' | 'summary';
export type DiffGranularity = 'line' | 'word' | 'section';

export interface DiffHunk {
  section_title?: string;
  before: string;
  after: string;
  change_type: 'added' | 'removed' | 'modified';
}

export interface DiffSummary {
  /** Number of pure-addition lines (no paired removal). */
  added_lines: number;
  /** Number of pure-removal lines (no paired addition). */
  removed_lines: number;
  /** Number of paired delete+insert lines (git's "modified" semantics). */
  modified_lines: number;
  /** Slice 8 / M12: sum of `added_line_chars + removed_line_chars` across
   * the LCS edit script (i.e. total character cost of the change before
   * pairing modified runs). Stays comparable across line / word / section
   * granularities so callers can rank diffs by size without re-parsing
   * the hunks. */
  total_changed_chars: number;
}

/**
 * Structural placeholder for the `diff` tool output. Slice A1 registers the
 * surface; slice B1 wires the real implementation against the existing LCS in
 * `src/cache/diff-summary.ts`. When the input exceeds the LCS size cap, B1
 * will set `truncated: true` and fall back to the existing diff-summary shape.
 */
export interface DiffOutput {
  changed: boolean;
  unified_diff?: string;
  hunks?: DiffHunk[];
  summary?: DiffSummary;
  truncated?: boolean;
  /** Stub-only marker — present while the slice is still a placeholder. */
  notice?: string;
  /** Stub-only marker — names the slice that will complete this surface. */
  slice?: string;
}

// --- Watch tool (slice A1 placeholder, full impl lands in B3) ---

export type WatchAction = 'create' | 'list' | 'check' | 'pause' | 'resume' | 'delete';
export type WatchJobStatus = 'active' | 'paused' | 'errored';

export interface WatchJobInput {
  action: WatchAction;
  /** Single-URL create: use `url`. The handler returns `{ job }` (singular). */
  url?: string;
  /** Slice 8 / M17: batch-create. Pass an array of URLs to register multiple
   * jobs in a single call. The handler returns `{ jobs[] }`. Mutually
   * exclusive with `url` — passing both is rejected. */
  urls?: string[];
  interval_seconds?: number;
  selector?: string;
  /** 'inline' (return on next check) or a webhook URL. */
  notification?: string;
  job_id?: string;
}

export interface WatchJob {
  id: string;
  url: string;
  interval_seconds: number;
  selector?: string;
  last_check_at?: number;
  last_content_hash?: string;
  status: WatchJobStatus;
  notification: string;
  created_at: number;
  /** How overdue the next check is, computed at read time. */
  staleness_seconds?: number;
}

export interface WatchJobOutput {
  /** Slice 8 / M17: emitted by `action:'create'` when exactly one URL was
   * passed (the single-URL path). The handler also keeps `jobs[]` for
   * back-compat; new callers should prefer `job`. */
  job?: WatchJob;
  /** Always emitted: list/check/pause/resume/delete operate on a job set
   * (even when size=1). create-batch (input.urls[]) emits jobs[] without
   * a `job` field. */
  jobs: WatchJob[];
  /** Per-job change report emitted by `action: 'check'`. The shape mirrors
   * the existing fetch/cache change-detector envelope so consumers can read
   * a single shape regardless of which surface ran the diff. */
  changes_since_last?: ChangeReport[];
  /** Stub-only marker — present while the slice is still a placeholder. */
  notice?: string;
  /** Stub-only marker — names the slice that will complete this surface. */
  slice?: string;
}

// --- Find Similar tool types (v3, Slice 23) ---

export interface MatchSignals {
  embedding_rank?: number;
  fts5_rank?: number;
  fused_score: number;
}

/**
 * Slice S7 (M10): opt-in per-result ranking debug. The audit observed that
 * `fts5_rank` and `embedding_rank` often disagree without any way to inspect
 * the disagreement; this surfaces the raw per-source ranks plus the fused
 * score so callers can audit the RRF behavior. Only emitted when
 * `FindSimilarInput.include_ranking_debug` is true.
 */
export interface RankingDebug {
  fts5_rank?: number;
  embedding_rank?: number;
  web_rank?: number;
  rrf_score: number;
}

export interface FindSimilarResult {
  url: string;
  title: string;
  markdown: string;
  relevance_score: number;
  /** Provenance: 'studio' = a captured session artifact (URI studio://<type>|<id>),
   * 'cache' = a fetched url_cache page, 'search' = a live web result. */
  source: 'cache' | 'search' | 'studio';
  /**
   * Whether the body bytes are safe AS INSTRUCTIONS — the at-rest continuation of
   * the 6a in-flight `trusted` tag (studio-dispatch.ts). Mirrors
   * studio_artifacts.content_trusted, NOT curated_by_human: page-derived content
   * (studio clips/qa, url_cache pages, web results) is `false` even once a human
   * curates it; only a human-authored studio note is `true`. Required on EVERY
   * result so a caller never receives an untagged row.
   */
  trusted: boolean;
  match_signals: MatchSignals;
  /** Slice S7 (M10): opt-in via FindSimilarInput.include_ranking_debug. */
  ranking_debug?: RankingDebug;
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
  /**
   * Hard post-filter on `match_signals.fused_score`. Results with a raw fused
   * score strictly less than `threshold` are dropped. Empty array is the
   * correct answer when nothing meets the threshold. `0` (default) keeps all
   * results.
   *
   * Note: this filters on the raw RRF/embedding fused score, NOT the
   * (normalized) `relevance_score` shown to callers — the raw signal is the
   * one the audit's H8 case reports (`threshold: 0.95` vs `fused_score: 0.029`).
   */
  threshold?: number;
  /**
   * Slice S7 (M10): when true, every result includes a `ranking_debug` block
   * with the raw fts5/embedding/web ranks and the raw RRF score so callers
   * can inspect rank disagreement. Off by default — the standard response
   * shape stays slim.
   */
  include_ranking_debug?: boolean;
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
