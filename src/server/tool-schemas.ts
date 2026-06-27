import type { ToolName } from '../instructions.js';

export type ToolSchema = {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  /** Client-side hint that unknown keys are rejected. NOT the boundary control — the host
   *  handler reads only the fields it needs (studio_capture enforces trust + session there). */
  additionalProperties?: boolean;
};

export const FETCH_TOOL_SCHEMA = {
  type: 'object' as const,
  properties: {
    url: { type: 'string', description: 'URL to fetch' },
    render_js: {
      type: 'string',
      enum: ['auto', 'always', 'never'],
      description: 'JavaScript rendering mode (default: auto)',
    },
    use_auth: {
      type: 'boolean',
      description: 'Use stored auth credentials (default: false)',
    },
    max_chars: {
      type: 'number',
      description: 'Maximum characters to return (hard slice)',
    },
    max_content_chars: {
      type: 'number',
      description: 'Smart truncate markdown to N chars at paragraph/heading boundary with [... content truncated] marker. Preferred over max_chars for AI agents.',
    },
    section: {
      type: 'string',
      description: 'Extract a specific section by heading text',
    },
    section_index: {
      type: 'number',
      description: 'Index of the section match (default: 0)',
    },
    screenshot: {
      type: 'boolean',
      description: 'Capture a screenshot (default: false)',
    },
    headers: {
      type: 'object',
      description: 'Additional HTTP headers',
      additionalProperties: { type: 'string' },
    },
    force_refresh: {
      type: 'boolean',
      description: 'Bypass cache and fetch fresh content from the network. Use for rapidly changing pages (news, changelogs, dashboards).',
    },
    max_tokens_out: {
      type: 'number',
      description: "Token-budget cap on total output. Uses cl100k-base BPE; non-OpenAI tokenizer counts may drift ~5-15%. When both max_tokens_out and max_chars are set, max_tokens_out wins.",
    },
    include_full_markdown: {
      type: 'boolean',
      description: 'Include full markdown body in the response. Default false on multi-result tools (returns evidence excerpts only); set true to restore.',
    },
    citation_format: {
      type: 'string',
      enum: ['numbered', 'anthropic_tags', 'json'],
      description: "Citation rendering style. 'numbered' (default) inline [N] markers; 'json' returns a citations[] array; 'anthropic_tags' wraps sources in <source id='...'> tags.",
    },
    actions: {
      type: 'array',
      description:
        'Sequential browser actions to perform before extracting content. ' +
        'When present, forces browser rendering (bypasses HTTP-first routing).',
      items: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['click', 'type', 'wait', 'wait_for', 'scroll', 'screenshot'],
            description: 'Action type',
          },
          selector: {
            type: 'string',
            description: 'CSS selector (required for click, type, wait_for)',
          },
          text: {
            type: 'string',
            description: 'Text to type (required for type action)',
          },
          ms: {
            type: 'number',
            description: 'Milliseconds to wait (required for wait action)',
          },
          timeout: {
            type: 'number',
            description: 'Timeout in ms for wait_for action (default: 5000)',
          },
          direction: {
            type: 'string',
            enum: ['down', 'up'],
            description: 'Scroll direction (required for scroll action)',
          },
          amount: {
            type: 'number',
            description: 'Scroll amount in pixels (default: viewport height)',
          },
        },
        required: ['type'],
      },
    },
    mode: {
      type: 'string',
      enum: ['cache', 'default', 'stealth'],
      description: "cache=HTTP-only, accepts stale cache. default=standard fetch with JS detection. stealth=full browser render.",
    },
  },
  required: ['url'],
};

export const SEARCH_TOOL_SCHEMA = {
  type: 'object' as const,
  properties: {
    query: {
      oneOf: [
        { type: 'string', description: 'Search query' },
        {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of query variants to search in parallel, deduplicate, and rerank',
        },
      ],
      description: 'Search query — a single string or array of query variants for parallel multi-query search',
    },
    max_results: { type: 'number', description: 'Max results to return (default 5, max 20)' },
    max_fetches: { type: 'number', description: 'Cap on how many top-ranked results have their page content fetched. Defaults to max_results. Set lower (e.g. 3) to keep snippet-only listings cheap and only deep-read the most relevant.' },
    include_content: { type: 'boolean', description: 'Fetch full content for results (default true)' },
    content_max_chars: { type: 'number', description: 'Max chars per result content at extraction (default 30000)' },
    max_content_chars: { type: 'number', description: 'Smart-truncate each result markdown at paragraph boundary with marker (e.g. 3000 for compact context)' },
    max_total_chars: { type: 'number', description: 'Max total chars across all results (default 50000)' },
    time_range: {
      type: 'string',
      enum: ['day', 'week', 'month', 'year'],
      description: 'Freshness filter (day/week/month/year). Conservative: only drops results with a confidently-extracted published_date — pages with no parseable date pass through, so this is a precision-boost not a hard bound. For strict ranges use from_date+to_date with a date-aware category (news, papers).',
    },
    exact_match: {
      type: 'boolean',
      description: 'Treat the query as a quoted phrase. Engines that honour `"..."` filter to phrase matches, and results without the exact phrase in title or snippet are dropped.',
    },
    search_engines: { type: 'array', items: { type: 'string' }, description: 'Override engine selection' },
    language: { type: 'string', description: 'Language preference' },
    country: {
      type: 'string',
      description: 'ISO 3166-1 alpha-2 country code (e.g. "us", "gb", "de"). Hint passed to engines that support a geographic boost (Bing cc=, DDG kl=, Brave country=); advisory, not a strict filter.',
    },
    include_domains: {
      type: 'array',
      items: { type: 'string' },
      description: 'Only return results from these domains (e.g. ["react.dev", "github.com"])',
    },
    exclude_domains: {
      type: 'array',
      items: { type: 'string' },
      description: 'Never return results from these domains',
    },
    from_date: {
      type: 'string',
      description: 'ISO date (YYYY-MM-DD) — only return results published after this date',
    },
    to_date: {
      type: 'string',
      description: 'ISO date (YYYY-MM-DD) — only return results published before this date',
    },
    category: {
      type: 'string',
      enum: ['general', 'news', 'code', 'docs', 'papers', 'images'],
      description: 'Category of search (general, news, code, docs, papers, images)',
    },
    format: {
      type: 'string',
      enum: ['answer', 'stream_answer'],
      description:
        "LLM-synthesis modes only. Omit for default evidence shape. 'answer'/'stream_answer' request sampling synthesis (falls back to evidence). Retired values 'full'/'context'/'highlights' reject with a migration error.",
    },
    max_highlights: {
      type: 'number',
      description: "Maximum highlights to return (default 10). Highlights are 1-3 sentence passages scored by relevance to the query.",
    },
    force_refresh: {
      type: 'boolean',
      description: 'Bypass all caches (search results and page content). Use when you need the most current information.',
    },
    include_favicon: {
      type: 'boolean',
      description: 'Attach a per-result `favicon` URL derived from the result host. Cached per-domain across the call.',
    },
    include_images: {
      type: 'boolean',
      description: 'Aggregate engine-provided thumbnail/image hints into a top-level `images` array of `{url, alt?, source_url}`. Empty array if no engine surfaced one.',
    },
    max_tokens_out: {
      type: 'number',
      description: "Token-budget cap on total output. Uses cl100k-base BPE; non-OpenAI tokenizer counts may drift ~5-15%. When both max_tokens_out and max_chars are set, max_tokens_out wins.",
    },
    include_full_markdown: {
      type: 'boolean',
      description: 'Include full markdown body in the response. Default false on multi-result tools (returns evidence excerpts only); set true to restore.',
    },
    citation_format: {
      type: 'string',
      enum: ['numbered', 'anthropic_tags', 'json'],
      description: "Citation rendering style. 'numbered' (default) inline [N] markers; 'json' returns a citations[] array; 'anthropic_tags' wraps sources in <source id='...'> tags.",
    },
    mode: {
      type: 'string',
      enum: ['cache', 'default', 'stealth'],
      description: "cache=single-engine, no rerank, stale cache ok. default=standard multi-engine search. stealth=full browser for JS-heavy result pages.",
    },
    search_depth: {
      type: 'string',
      enum: ['ultra-fast', 'fast', 'balanced', 'deep'],
      description: 'Depth tier. ultra-fast=cache-only (≤300ms); on miss emits notice and empty results. fast=engines only, no content fetch / rerank (≤1s). balanced (default)=full pipeline. deep=balanced + full enrichment.',
    },
    agent_context: {
      type: 'object',
      description:
        'Optional agent context for ranking + dedup. text is concatenated with the query before embedding; recent_urls are dropped from results.',
      properties: {
        text: { type: 'string', description: 'Surrounding code / prior turn / task framing.' },
        recent_urls: { type: 'array', items: { type: 'string' }, description: 'URLs the agent has already seen.' },
        intent: { type: 'string', description: 'One-line task framing. Used when text is omitted.' },
      },
      additionalProperties: false,
    },
  },
  required: ['query'],
};

export const CRAWL_TOOL_SCHEMA = {
  type: 'object' as const,
  properties: {
    url: { type: 'string', description: 'Seed URL to start crawling from' },
    max_depth: { type: 'number', description: 'Maximum link depth from seed (default: 2)' },
    max_pages: { type: 'number', description: 'Maximum pages to crawl (default: 20)' },
    strategy: {
      type: 'string',
      enum: ['bfs', 'dfs', 'sitemap', 'map'],
      description: 'Crawl strategy: bfs (breadth-first), dfs (depth-first), sitemap (use sitemap.xml), map (URL-only discovery — returns list of URLs without content, faster than full crawl)',
    },
    include_patterns: {
      type: 'array',
      items: { type: 'string' },
      description: 'URL regex whitelist — only crawl matching URLs',
    },
    exclude_patterns: {
      type: 'array',
      items: { type: 'string' },
      description: 'URL regex blacklist — skip matching URLs',
    },
    use_auth: { type: 'boolean', description: 'Use stored auth credentials (default: false)' },
    extract_links: { type: 'boolean', description: 'Return link graph between pages (default: false)' },
    max_total_chars: { type: 'number', description: 'Max total chars across all pages (default: 100000)' },
    max_tokens_out: {
      type: 'number',
      description: "Token-budget cap on total output. Uses cl100k-base BPE; non-OpenAI tokenizer counts may drift ~5-15%. When both max_tokens_out and max_chars are set, max_tokens_out wins.",
    },
    include_full_markdown: {
      type: 'boolean',
      description: 'Include full markdown body in the response. Default false on multi-result tools (returns evidence excerpts only); set true to restore.',
    },
    citation_format: {
      type: 'string',
      enum: ['numbered', 'anthropic_tags', 'json'],
      description: "Citation rendering style. 'numbered' (default) inline [N] markers; 'json' returns a citations[] array; 'anthropic_tags' wraps sources in <source id='...'> tags.",
    },
  },
  required: ['url'],
};

export const CACHE_TOOL_SCHEMA = {
  type: 'object' as const,
  properties: {
    query: { type: 'string', description: 'Full-text search over cached content' },
    url_pattern: {
      type: 'string',
      description: 'Filter by URL glob pattern (e.g., "*example.com*")',
    },
    since: {
      type: 'string',
      description: 'ISO date — only results cached after this date',
    },
    clear: {
      type: 'boolean',
      description: 'Clear matching cache entries (requires at least one filter: query, url_pattern, or since)',
    },
    stats: {
      type: 'boolean',
      description: 'Return cache statistics (total URLs, size, date range)',
    },
    check_changes: {
      type: 'boolean',
      description:
        'Re-fetch all matching cached URLs and report which ones have changed. ' +
        'Returns a list of URLs with changed/unchanged status and diff summaries. ' +
        'Use with query or url_pattern to scope which cached entries to check.',
    },
    mode: {
      type: 'string',
      enum: ['fts', 'hybrid'],
      description:
        'Search strategy when query is provided. "fts" (default) runs keyword-only BM25 over the FTS5 index. ' +
        '"hybrid" additionally runs semantic vector search and fuses both rankings with reciprocal rank fusion ' +
        'for higher-recall lookups; falls back to FTS when the embedding index is empty or unavailable.',
    },
    limit: {
      type: 'number',
      description: 'Maximum number of results to return (default 20).',
    },
    max_tokens_out: {
      type: 'number',
      description: "Token-budget cap on total output (cl100k-base BPE). Caps the aggregate size of all returned markdown bodies; bodies past the budget are truncated or dropped.",
    },
  },
};

export const EXTRACT_TOOL_SCHEMA = {
  type: 'object' as const,
  properties: {
    url: { type: 'string', description: 'URL to fetch and extract from' },
    html: { type: 'string', description: 'Raw HTML to extract from (url takes priority if both provided)' },
    mode: {
      type: 'string',
      enum: ['selector', 'tables', 'metadata', 'schema', 'structured', 'brand'],
      description:
        'selector | tables | metadata | schema (LLM-sourced fields verified against source; hallucinated values returned as null) | structured | brand (logo/favicon/colors/fonts/social_links with provenance; favicons never promote to logo_url)',
    },
    css_selector: {
      type: 'string',
      description: 'CSS selector to match (required when mode="selector")',
    },
    multiple: {
      type: 'boolean',
      description: 'Return array of all matches instead of first (default: false, only for mode="selector")',
    },
    schema: {
      type: 'object',
      description: 'JSON Schema defining fields to extract. Field names are matched against page content via CSS classes, ARIA labels, microdata, and JSON-LD. Required when mode="schema".',
    },
    named_schema: {
      type: 'string',
      enum: ['Article', 'Recipe', 'Product', 'CodeSnippet', 'Paper', 'EventListing'],
      description: 'Extract page data into a strict named schema (heuristic only; no LLM required). Mutually exclusive with `schema`.',
    },
    max_tokens_out: {
      type: 'number',
      description: "Token-budget cap on extracted output (cl100k-base BPE). Trims structured/table/schema results to fit; trailing rows or heavy keys are dropped first.",
    },
  },
};

export const FIND_SIMILAR_TOOL_SCHEMA = {
  type: 'object' as const,
  properties: {
    url: {
      type: 'string',
      description: 'Find pages similar to this URL. The page is fetched (or read from cache) and its content analyzed for key terms.',
    },
    concept: {
      type: 'string',
      description: 'Find pages related to this concept or topic description. Use when you don\'t have a specific URL.',
    },
    max_results: {
      type: 'number',
      description: 'Maximum results to return (default 10, max 50)',
    },
    include_domains: {
      type: 'array',
      items: { type: 'string' },
      description: 'Only return results from these domains',
    },
    exclude_domains: {
      type: 'array',
      items: { type: 'string' },
      description: 'Never return results from these domains',
    },
    include_cache: {
      type: 'boolean',
      description: 'Search local cache for similar pages (default: true)',
    },
    include_web: {
      type: 'boolean',
      description: 'Supplement with web search if needed (default: true)',
    },
    mode: {
      type: 'string',
      enum: ['auto', 'cache', 'web-expansion', 'crawl-rank'],
      default: 'auto',
      description: "Retrieval strategy: cache (local hybrid), web-expansion (key terms + web search), crawl-rank (1-hop crawl from seed URL + embed + cosine rank), or auto.",
    },
    max_tokens_out: {
      type: 'number',
      description: "Token-budget cap on total output. Uses cl100k-base BPE; non-OpenAI tokenizer counts may drift ~5-15%. When both max_tokens_out and max_chars are set, max_tokens_out wins.",
    },
    include_full_markdown: {
      type: 'boolean',
      description: 'Include full markdown body in the response. Default false on multi-result tools (returns evidence excerpts only); set true to restore.',
    },
    citation_format: {
      type: 'string',
      enum: ['numbered', 'anthropic_tags', 'json'],
      description: "Citation rendering style. 'numbered' (default) inline [N] markers; 'json' returns a citations[] array; 'anthropic_tags' wraps sources in <source id='...'> tags.",
    },
    threshold: {
      type: 'number',
      description: 'Hard post-filter on match_signals.fused_score. Results below this raw fused score are dropped (empty array is correct when nothing qualifies). Default 0 (no filtering). Note: filters on the raw RRF/embedding score, not the normalized relevance_score.',
    },
    include_ranking_debug: {
      type: 'boolean',
      description: "Attach per-result ranking_debug { fts5_rank, embedding_rank, web_rank, rrf_score } so callers can audit disagreement between the three ranking sources. Off by default. Concept-mode results improve materially with a warm cache — run wigolo_crawl on the relevant docs before relying on concept-only retrieval.",
    },
  },
};

export const RESEARCH_TOOL_SCHEMA = {
  type: 'object' as const,
  properties: {
    question: { type: 'string', description: 'The research question to investigate' },
    depth: {
      type: 'string',
      enum: ['quick', 'standard', 'comprehensive'],
      description: 'Research depth: quick (~15s), standard (~40s, default), comprehensive (~80s)',
    },
    max_sources: {
      type: 'number',
      description: 'Override the default source count for the chosen depth (max 50)',
    },
    include_domains: {
      type: 'array',
      items: { type: 'string' },
      description: 'Only search results from these domains',
    },
    exclude_domains: {
      type: 'array',
      items: { type: 'string' },
      description: 'Exclude results from these domains',
    },
    schema: {
      type: 'object',
      description: 'Optional JSON Schema -- structure the report to extract these fields',
    },
    stream: {
      type: 'boolean',
      description: 'Send progress notifications as each research phase completes',
    },
    max_tokens_out: {
      type: 'number',
      description: "Token-budget cap on total output. Uses cl100k-base BPE; non-OpenAI tokenizer counts may drift ~5-15%. When both max_tokens_out and max_chars are set, max_tokens_out wins.",
    },
    include_full_markdown: {
      type: 'boolean',
      description: 'Include full markdown body in the response. Default false on multi-result tools (returns evidence excerpts only); set true to restore.',
    },
    citation_format: {
      type: 'string',
      enum: ['numbered', 'anthropic_tags', 'json'],
      description: "Citation rendering style. 'numbered' (default) inline [N] markers; 'json' returns a citations[] array; 'anthropic_tags' wraps sources in <source id='...'> tags.",
    },
  },
  required: ['question'],
};

export const AGENT_TOOL_SCHEMA = {
  type: 'object' as const,
  properties: {
    prompt: {
      type: 'string',
      description: 'Natural-language description of what data to gather',
    },
    urls: {
      type: 'array',
      items: { type: 'string' },
      description: 'Specific URLs to include in the data gathering',
    },
    schema: {
      type: 'object',
      description: 'Optional JSON Schema -- extract structured data matching this schema from each page',
    },
    max_pages: {
      type: 'number',
      description: 'Maximum pages to fetch (default 10, max 100)',
    },
    max_time_ms: {
      type: 'number',
      description: 'Maximum execution time in milliseconds (default 60000)',
    },
    stream: {
      type: 'boolean',
      description: 'Send progress notifications as each step completes',
    },
    max_tokens_out: {
      type: 'number',
      description: "Token-budget cap on total output. Uses cl100k-base BPE; non-OpenAI tokenizer counts may drift ~5-15%. When both max_tokens_out and max_chars are set, max_tokens_out wins.",
    },
    include_full_markdown: {
      type: 'boolean',
      description: 'Include full markdown body in the response. Default false on multi-result tools (returns evidence excerpts only); set true to restore.',
    },
    citation_format: {
      type: 'string',
      enum: ['numbered', 'anthropic_tags', 'json'],
      description: "Citation rendering style. 'numbered' (default) inline [N] markers; 'json' returns a citations[] array; 'anthropic_tags' wraps sources in <source id='...'> tags.",
    },
  },
  required: ['prompt'],
};

// Slice A1: registration-only stub. The real implementation lands in slice B1
// (see docs/superpowers/specs/2026-05-26-webclaw-gap-closure-design.md §5).
// `old` / `new` are unconstrained objects here so the wire shape can evolve in
// B1 without re-rolling the schema; the stub handler does not consume them.
export const DIFF_TOOL_SCHEMA = {
  type: 'object' as const,
  properties: {
    old: {
      type: 'object',
      description: 'Left-hand side of the diff. One of { url, markdown, content_hash } will be required in slice B1.',
      additionalProperties: true,
    },
    new: {
      type: 'object',
      description: 'Right-hand side of the diff. One of { url, markdown } will be required in slice B1.',
      additionalProperties: true,
    },
    output: {
      type: 'string',
      enum: ['unified', 'hunks', 'summary'],
      description: 'Diff output shape. unified=git-style patch, hunks=structured per-section, summary=counts only (added_lines / removed_lines / modified_lines / total_changed_chars where total_changed_chars = sum of added_line_chars + removed_line_chars across the LCS edit script). Default: unified.',
    },
    granularity: {
      type: 'string',
      enum: ['line', 'word', 'section'],
      description: 'Diff granularity. line=per-line LCS (default). word=token-level LCS — hunks contain only the changed tokens, tighter than line for intra-line edits. section walks H1/H2/H3 boundaries.',
    },
  },
};

// Slice A1: registration-only stub. Real implementation lands in slice B3
// (see docs/superpowers/specs/2026-05-26-webclaw-gap-closure-design.md §5).
// Lazy-execution model — there is no background daemon; checks happen when
// the tool is called or when another tool runs and the job is overdue.
export const WATCH_TOOL_SCHEMA = {
  type: 'object' as const,
  properties: {
    action: {
      type: 'string',
      enum: ['create', 'list', 'check', 'pause', 'resume', 'delete'],
      description: 'Watch-job action.',
    },
    url: {
      type: 'string',
      description: 'Single-URL create: the URL to watch. Response carries `job` (singular) and `jobs:[job]` (legacy). Mutually exclusive with `urls`.',
    },
    urls: {
      type: 'array',
      items: { type: 'string' },
      description: 'Batch create: register multiple jobs in one call. Response carries `jobs[]` only (no `job`). Mutually exclusive with `url`.',
    },
    interval_seconds: {
      type: 'number',
      description: 'Required for action=create. Minimum check interval (min 60).',
    },
    selector: {
      type: 'string',
      description: 'Optional CSS selector to scope the diff to a subtree (create-only).',
    },
    notification: {
      type: 'string',
      description: '"inline" (return on next check) or a webhook URL. Default: inline.',
    },
    job_id: {
      type: 'string',
      description: 'Required for action=check|pause|resume|delete.',
    },
  },
  required: ['action'],
};

export const STUDIO_OBSERVE_TOOL_SCHEMA = {
  type: 'object' as const,
  properties: {
    since: {
      type: 'number',
      description: 'Event cursor from your last observe; pass it back to receive only newer human events and acknowledge the prior ones.',
    },
    base_id: {
      type: 'string',
      description: 'The page-snapshot id you currently hold; on a mismatch (reconnect or navigation) you get a fresh full snapshot instead of a diff.',
    },
    snapshot_ref: {
      type: 'string',
      description: 'Fetch a previously spilled (oversized) snapshot by its reference.',
    },
    narration: {
      type: 'string',
      description: 'Optional short note shown to the watching human (e.g. why you are reading the page now). Display-only and shown as inert text; it is not a command and is never stored.',
    },
  },
  required: [],
};

export const STUDIO_ACT_TOOL_SCHEMA = {
  type: 'object' as const,
  properties: {
    action: {
      type: 'string',
      enum: ['navigate', 'click', 'type', 'scroll'],
      description: 'What to do in the shared browser session: navigate to a URL, click an element, type text into an element, or scroll the page.',
    },
    url: {
      type: 'string',
      description: 'For navigate: the URL to open. Must be http(s); cloud-internal addresses are always blocked, and private/local addresses are blocked unless the human has granted it for this session.',
    },
    ref: {
      type: 'string',
      description: 'For click/type: the stable element ref from studio_observe. Resolved live at action time — a stale, ambiguous, or covered ref is refused (re-observe) rather than acting on the wrong element.',
    },
    text: {
      type: 'string',
      description: 'For type: the text to type into the element (it is focused first).',
    },
    direction: {
      type: 'string',
      enum: ['down', 'up'],
      description: 'For scroll: the direction to scroll (default down).',
    },
    amount: {
      type: 'number',
      description: 'For scroll: distance in page pixels (default 600).',
    },
    narration: {
      type: 'string',
      description: 'Optional short note shown to the watching human alongside this action (e.g. why you are clicking it). Display-only and shown as inert text; it is not a command and is never stored.',
    },
  },
  required: ['action'],
};

export const STUDIO_MARKS_TOOL_SCHEMA = {
  type: 'object' as const,
  properties: {
    op: {
      type: 'string',
      enum: ['list', 'generalize'],
      description: "Omit (or 'list') to read all marks; 'generalize' previews the repeating set a mark belongs to.",
    },
    markId: {
      type: 'string',
      description: "The mark to generalize (required when op='generalize').",
    },
  },
  required: [],
};

export const STUDIO_CAPTURE_TOOL_SCHEMA = {
  type: 'object' as const,
  properties: {
    type: {
      type: 'string',
      enum: ['clip', 'qa'],
      description: "What to capture. 'clip' saves a page region (needs content + url); 'qa' saves a question + answer pair from the session (url-less).",
    },
    content: {
      type: 'string',
      description: 'The content to save (clip only — the text/markdown).',
    },
    url: {
      type: 'string',
      description: 'The page url the clip was captured from (clip only).',
    },
    question: {
      type: 'string',
      description: 'The question (qa only).',
    },
    answer: {
      type: 'string',
      description: 'The answer (qa only).',
    },
  },
  // Only `type` is universally required; per-type fields (clip: content+url, qa: question+answer)
  // are validated by the host handler — the control — not the schema (a verbatim-args proxy makes
  // additionalProperties:false a client hint, so the handler reads only the per-type safe fields).
  required: ['type'],
  additionalProperties: false,
};

export const TOOL_SCHEMAS: Record<ToolName, ToolSchema> = {
  fetch: FETCH_TOOL_SCHEMA,
  search: SEARCH_TOOL_SCHEMA,
  crawl: CRAWL_TOOL_SCHEMA,
  cache: CACHE_TOOL_SCHEMA,
  extract: EXTRACT_TOOL_SCHEMA,
  find_similar: FIND_SIMILAR_TOOL_SCHEMA,
  research: RESEARCH_TOOL_SCHEMA,
  agent: AGENT_TOOL_SCHEMA,
  diff: DIFF_TOOL_SCHEMA,
  watch: WATCH_TOOL_SCHEMA,
  studio_observe: STUDIO_OBSERVE_TOOL_SCHEMA,
  studio_act: STUDIO_ACT_TOOL_SCHEMA,
  studio_marks: STUDIO_MARKS_TOOL_SCHEMA,
  studio_capture: STUDIO_CAPTURE_TOOL_SCHEMA,
};
