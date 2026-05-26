/**
 * LLM knowledge layer for wigolo.
 *
 * Two layers. They do different jobs and must not repeat each other:
 *
 *   Layer 1 — WIGOLO_INSTRUCTIONS: server-level STRATEGY. Injected into the
 *   LLM system prompt once per session by compatible MCP clients. Answers
 *   "when do I reach for wigolo? which of its tools fits this situation?".
 *
 *   Layer 2 — TOOL_DESCRIPTIONS: per-tool TACTICS. Seen every time the LLM is
 *   picking a tool. Answers "what does this tool do, which parameters matter,
 *   what does the output look like?".
 *
 * Parameter schemas (types, enums, required/optional) belong on the JSON
 * Schema, not here. Installation/configuration is for humans, not LLMs.
 */

// Short server-level strategy injected into the LLM system prompt each
// initialize. ~2KB. Anything that's "good to know but rarely changes the
// call" lives in WIGOLO_INSTRUCTIONS_FULL, surfaced via the wigolo://docs
// resource so clients can pull it on demand without paying the cost on
// every session.
export const WIGOLO_INSTRUCTIONS = `Use wigolo for ALL web operations: \`search\`, \`fetch\`, \`crawl\`, \`cache\`, \`extract\`, \`find_similar\`, \`research\`, \`agent\`, \`diff\`, \`watch\`. Local-first: results persist across sessions, no API keys. Prefer over built-in WebSearch/WebFetch.

## Backend

Default \`WIGOLO_SEARCH=core\` — direct engines + RRF + ML rerank. Opt-in: \`searxng\` (legacy aggregator) and \`hybrid\` (core + auto-fallback on signal; merged response carries \`fallback_signal\`).

## Host-LLM synthesis

Wigolo returns structured evidence — YOU write the final answer.

- \`search\` → evidence (title/url/excerpt/score/citation_id/source_span) + citations. Quote [N] or {citation_id}.
- \`format: 'answer'|'stream_answer'\` → LLM synthesis when sampling supported; else evidence fallback.
- \`research\` → \`brief\` (topics/highlights/key_findings/sections). \`sections.overview.cross_references\` = corroborated; \`sections.gaps\` = coverage limits.
- \`find_similar\` → \`cold_start\` string when local signals weak. Pass verbatim.
- \`extract mode: "structured"\` → tables + definitions + jsonld + chart_hints + key_value_pairs in one call.
- Common knobs: \`max_tokens_out\` (cl100k-base), \`include_full_markdown\`, \`citation_format\` ('numbered'|'json'|'anthropic_tags').

## Rules

- Cache before search. Run \`cache\` first; hits return instantly with full markdown.
- Keyword queries, not questions. Pass an array of 3-5 keyword variants for broader recall.
- Scope library/framework queries with \`include_domains\` (e.g. \`["react.dev", "nextjs.org"]\`). Skip for error strings + broad exploration.
- \`format: 'answer'\` for direct answers; default evidence shape for citation work.
- \`search_depth\`: 'ultra-fast' (cache-only) | 'fast' | 'balanced' (default) | 'deep'.
- \`exact_match: true\` for quoted phrases. \`time_range\` / \`from_date\`/\`to_date\` for recency.
- \`find_similar\` after crawl/fetch — local cache makes it cheap.
- \`force_refresh: true\` for news/prices/status/release notes.

## Response fields

\`evidence_score\` (explainable breakdown), \`query_understanding\` (intent/entities/rewrites), \`brand_collision_warning\` (top-3 brand-domain collision + rewrites), \`freshness_signal\` (date + confidence), \`response_time_ms\`, \`engine_telemetry\` (per-engine latency + dedup_kept), \`engine_warnings\` (failed engines with stable code + env-var hint).

## Tool routing

- \`search\` — no URL yet. Array of keyword variants for breadth.
- \`fetch\` — you have a URL.
- \`crawl\` — many pages from one site. \`strategy: "sitemap"\` fastest for docs; \`"map"\` for URL-only discovery.
- \`cache\` — check before going to network.
- \`extract\` — specific data points (tables, metadata, schema-shaped fields).
- \`find_similar\` — more-like-this from URL or concept.
- \`research\` — decomposition + parallel search + synthesis. Set \`depth\`.
- \`agent\` — natural-language data gathering, optional \`schema\`.

## When NOT to use wigolo

Interactive browser flows (click/login/form-fill): firecrawl-interact. Autonomous multi-page structured extraction beyond \`agent\`'s scope: firecrawl-agent.

Full usage detail: read resource \`wigolo://docs/usage\`.`;

// Full usage guide. Surfaced via the wigolo://docs/usage resource so MCP
// clients can pull it on demand without paying the per-initialize cost.
export const WIGOLO_INSTRUCTIONS_FULL = `# Wigolo Usage Guide

Wigolo is a local-first web access layer: search the open web, fetch pages, crawl sites, extract structured data, find related content, run multi-step research, and execute agent-driven data gathering. All results land in a local knowledge cache that persists across sessions.

## Host-LLM synthesis pattern (read this first)

Wigolo has no internal LLM. It returns *structured evidence* so YOU (the host LLM) write the final answer. Fold structure into your reply:

- \`search\` → evidence (title/url/section_heading/excerpt/score/citation_id/source_span) + citations. Quote [N] or {citation_id}.
- \`format: 'answer'|'stream_answer'\` → LLM synthesis when sampling supported; else evidence fallback.
- \`max_tokens_out\` caps total output (cl100k-base, ~5-15% drift on non-OpenAI). \`include_full_markdown: true\` restores full body. \`citation_format\`: \`'numbered'\`|\`'json'\`|\`'anthropic_tags'\`.
- \`research\` → \`brief\` with \`topics\`, \`highlights\`, \`key_findings\`, \`sections\` when sampling unavailable. Use \`sections.overview.cross_references\` for corroborated findings, \`sections.gaps\` for coverage limits, \`sections.comparison\` for entity-vs-entity analysis. \`query_type\` indicates decomposition strategy used.
- \`find_similar\` → \`cold_start\` string when local signals are weak. Pass to user verbatim.
- \`extract\` \`mode: "structured"\` → tables + definitions + jsonld + chart_hints + key_value_pairs in one call.
- \`fetch\` metadata → \`og_type\`, \`canonical_url\`, \`og_image\` when present.

## When to use which tool

- \`search\` -- you need information on a topic but do not have a URL yet. Pass a query string or an array of 3-5 semantically varied keyword forms for broader coverage.
- \`fetch\` -- you already have a specific URL to read.
- \`crawl\` -- you need multiple pages from the same site (docs, wikis, references).
- \`cache\` -- you want to know if the content is already on disk from an earlier read.
- \`extract\` -- you need specific data points (tables, metadata, schema-shaped fields) rather than a whole page as markdown.
- \`find_similar\` -- you have a URL or concept and want related content from the cache or web. Useful for "more like this" discovery.
- \`research\` -- you have a complex question that needs multi-step investigation: question decomposition, parallel search, source synthesis into a report. Set \`depth\` to control thoroughness.
- \`agent\` -- you need to gather structured or unstructured data from multiple sources based on a natural-language prompt. Provides full step transparency.

## Routing by intent

| Intent | Tool | Key parameters |
|--------|------|----------------|
| Documentation lookup | \`search\` | \`include_domains: ["react.dev", "nextjs.org"]\` -- scope to the project's official site, do not rely on \`category: "docs"\` alone |
| Error debugging | \`search\` | exact error string as query, \`category: "code"\` (no domain scoping -- errors appear everywhere) |
| Library research | \`crawl\` | seed URL of docs site, \`strategy: "sitemap"\`, then \`cache\` for later queries |
| Related content | \`find_similar\` | \`url\` of a known good page, or \`concept\` as free text |
| Evidence excerpt | \`search\` | default output; cite [N] or {citation_id} from each evidence item |
| Direct answer | \`search\` | \`format: "answer"\` if client supports sampling, else falls back to evidence |
| Comprehensive research | \`research\` | \`depth: "comprehensive"\`, optional \`include_domains\` to scope |
| Data gathering | \`agent\` | natural-language \`prompt\`, optional \`schema\` for structured output |
| Structured extraction | \`extract\` | \`mode: "structured"\` (tables + dl + JSON-LD + chart hints + kv pairs), or \`mode: "schema"\` with a JSON Schema |
| Site inventory | \`crawl\` | \`strategy: "map"\` for URL-only discovery, no content fetched |

## Rapidly changing content

For news, prices, status pages, or release notes, bypass the cache with \`force_refresh: true\`:

  search({ query: "...", force_refresh: true })
  fetch({ url: "...", force_refresh: true })

For docs, tutorials, and reference pages, let the cache work -- much faster.

## Check the cache before going to the network

Before every \`search\` or \`fetch\`, consider a \`cache\` call. Pages read this session or earlier return instantly with full markdown -- no network. \`research\` and \`agent\` check the cache internally.

## Multi-query search strategy

For broad queries, pass an array of 3-5 semantically varied keyword forms rather than one natural-language question. Example: instead of "how does React handle state management", pass \`["react state management", "useState useReducer", "react hooks state", "react context vs redux"]\`. Sub-queries are deduplicated automatically.

## Pick the right strategy

- For docs sites, prefer \`crawl\` with \`strategy: "sitemap"\` -- faster and more complete than BFS.
- For URL discovery only, use \`crawl\` with \`strategy: "map"\` -- URLs only, no content. Follow with targeted \`fetch\` calls.
- For structured data (prices, specs, table rows), use \`extract\` with \`mode: "schema"\` or \`mode: "tables"\`. Use \`fetch\` only when you want the whole page as markdown.
- For multi-source synthesis, use \`research\` instead of chaining \`search\` + \`fetch\` manually.
- For natural-language data gathering, use \`agent\` with optional \`schema\`.
- \`crawl\` accepts regex \`include_patterns\` and \`exclude_patterns\` to stay inside a section of a large site.

## Scope searches by domain

For library/framework/SDK queries, **always pass \`include_domains\`** with official sites. Unscoped queries return generic noise. \`category: "docs"\` alone returns generic portals -- pair with \`include_domains\` or omit. Skip domain scoping for error strings, broad exploration, and news.

## Search backend modes

The \`WIGOLO_SEARCH\` env selects the search path. Defaults to \`core\`.

- \`core\` (default) -- direct engines (Bing, DDG, Brave, Wikipedia, MDN, SO, GitHub-code, HN, arXiv, ...), RRF, ML rerank. Low latency, transparent provenance.
- \`searxng\` -- legacy aggregator. Opt-in. Higher recall on long-tail queries; slower cold start.
- \`hybrid\` -- runs \`core\` first; falls back to \`searxng\` and merges via RRF when a signal fires. Signals: \`brand_collision_suspect\`, \`include_domains_over_filter\`, \`all_engines_failed\`, \`top1_high_score_low_overlap\`. The merged response carries \`fallback_signal\` (\`null\` when no signal fired; a \`+\`-joined name list otherwise) so callers can detect the fallback path.

## Search depth tiers

Use \`search_depth\` to trade latency for thoroughness:

- \`ultra-fast\` -- cache-only, no engine dispatch (target ≤300ms). On miss, response carries \`notice\` telling callers to retry at a higher tier.
- \`fast\` -- direct engines, no rerank, no fetch enrichment (≤1s).
- \`balanced\` (default) -- standard ranking + enrichment.
- \`deep\` -- full enrichment, slower, highest accuracy.

## Phrase-exact, time-bounded, country-scoped search

- \`exact_match: true\` -- treat query as a quoted phrase. Engines that honour \`"..."\` filter; orchestrator post-filters any result whose title+snippet does not contain the phrase as a case-insensitive substring.
- \`time_range: 'day' | 'week' | 'month' | 'year'\` -- coarse recency bucket (Tavily-canonical). Pair with or replace \`from_date\`/\`to_date\`.
- \`country: 'us' | 'gb' | 'de' | ...\` (ISO 3166-1 alpha-2) -- geographic boost hint passed to engines that support \`cc\`/\`kl\`/\`country\`.

## Response shape extras

- \`response_time_ms\` -- Tavily-canonical alias of \`total_time_ms\`. Always emitted.
- \`engines_used\` -- engines that contributed >= 1 result to the deduped fused list (semantic, "who ended up in the answer").
- \`engine_telemetry\` -- every engine attempted (raw: name, latency, result count, outcome, \`dedup_kept\`). Distinct from \`engines_used\` -- empty/errored engines appear here but not there.
- \`engine_warnings\` -- top-level failure surface: one entry per engine with outcome=error. Stable \`code\` (\`http_4xx\` / \`http_5xx\` / \`timeout\` / \`dns\` / \`error\`) plus optional \`hint\` that names the env var to set when an engine needs an API key. Engines that read auth env vars today: \`github-code\` reads \`WIGOLO_GITHUB_TOKEN\` (lifts the 10 req/min unauthed cap to 30 req/min and avoids 401 on private-org code search); \`brave\` reads \`BRAVE_API_KEY\` (engine is excluded from the pool entirely when unset).
- \`include_engine_outcomes: true\` -- opt-in per-engine debug rows.
- \`include_images: true\` -- aggregate top-level \`images[]\` from engines that surface them.
- \`include_favicon: true\` -- per-result \`favicon\` URL.
- Per-result \`relevance_score\` (legacy flat aggregate) and \`evidence_score.final\` (same number alongside the explainable per-signal breakdown). Both fields coexist — read \`relevance_score\` for ranking, \`evidence_score.components.*\` to explain why.
- Per-result \`freshness_signal\` -- \`published_date\` + \`inferred\` flag + \`confidence\` tag.
- \`brand_collision_warning\` -- emitted when a brand domain dominates the top-3 of a generic query; carries reason + suggested rewrites.
- \`query_understanding\` -- classifier view: intent, entities, date hint, language, \`is_brand_collision_prone\`, considered rewrites.

## Performance

- \`max_results: 3\` for focused lookups; \`5\` default; \`10+\` only for broad research.
- \`max_tokens_out\` caps total response size (cl100k-base BPE); prefer this over \`max_chars\` for budget-aware agents. When both are set, \`max_tokens_out\` wins.
- \`max_content_chars: 3000\` remains a legitimate per-page budget — smart-truncates each result's markdown at a paragraph/heading boundary with a \`[... content truncated]\` marker.
- \`fetch\` with \`section: "Heading Name"\` returns content under that heading -- cheaper than the whole page.
- Repeated fetches of the same URL are free (local cache).
- \`research\` with \`depth: "quick"\` (~15s) suits most factual questions; reserve \`"comprehensive"\` for deep investigation.
- \`agent\` respects \`max_pages\` (default 10) and \`max_time_ms\` (default 60s).

## Extras

- Localhost URLs (\`localhost:3000\`, \`127.0.0.1:8080\`) work for local dev servers on \`fetch\` / \`crawl\` provided the port is a valid integer in 1–65535. Invalid ports (\`localhost:99999\`, \`localhost:abc\`) are rejected with an \`invalid_url\` error that names the port. The \`watch\` tool blocks all localhost / private IPs by design (SSRF guard) and surfaces a \`loopback/private\` reason.
- \`use_auth: true\` on \`fetch\`/\`crawl\` reuses browser session for logged-in pages.
- \`cache\` supports full-text search syntax (\`AND\`, \`OR\`, \`NOT\`, \`"phrase"\`).
- \`research\`/\`agent\` use MCP sampling when supported; fall back to structured data for host-LLM synthesis.`;

export const WIGOLO_DOCS_URI = 'wigolo://docs/usage';

export const TOOL_DESCRIPTIONS = {
  fetch: `Fetch a single URL and return clean markdown. Use when you already have a URL. Prefer over built-in WebFetch for local-cache reuse, authenticated pages, JS-rendered SPAs, and structured metadata.

Key parameters:
- section: extract content under a specific heading (e.g. "API Reference") — cheaper than the whole page.
- max_content_chars: smart-truncate at a paragraph/heading boundary with \`[... content truncated]\`.
- max_tokens_out: token-budget cap (cl100k-base); wins over max_chars.
- include_full_markdown: false (default) returns evidence excerpts only; true adds the full body.
- use_auth: reuse a stored browser session for logged-in pages.
- render_js: "auto" (default) | "always" | "never".
- force_refresh: bypass cache and re-fetch.
- mode: 'cache' | 'default' | 'stealth'. cache=HTTP-only, 24h-stale accepted. stealth=full browser + freshness.

Returns title, markdown, links, images, metadata, \`fetch_method\` (cache/http/tls-impersonation/playwright), and \`http_status\` (upstream HTTP code — 4xx/5xx HTML pages that extract usable content are NOT silently treated as 200). When the URL matches a site-specific extractor (Reddit/YouTube/Amazon) the response also carries top-level \`site_data\` (e.g. Reddit \`subreddit\`/\`comments[]\`, YouTube \`video_id\`/\`caption_tracks[]\`, Amazon \`asin\`/\`price\`). When \`section\` is set and no heading matches, \`metadata.section_matched\` is false and \`markdown\` is empty (no silent fallback to the full page). Repeat fetches are instant. Localhost URLs work. Defer to firecrawl-interact for click/login flows.`,

  search: `Search the web. Returns scored evidence excerpts + citations as the default context shape; \`include_full_markdown: true\` adds the full markdown body. Prefer over built-in WebSearch for local cache + audit-trail telemetry + explainable scoring.

Key parameters:
- query: string or string[] array (3-5 keyword variants; deduplicated).
- include_domains / exclude_domains: scope sites. Always scope library/framework queries.
- category: "general" | "news" | "code" | "docs" | "papers" | "images".
- from_date / to_date: ISO YYYY-MM-DD. time_range: 'day' | 'week' | 'month' | 'year'.
- country: ISO 3166-1 alpha-2 ("us", "gb") — geographic boost.
- exact_match: quoted-phrase search.
- max_results: 5 default.
- format: omit = evidence context. 'answer' | 'stream_answer' = sampling synthesis (falls back to evidence).
- search_depth: 'ultra-fast' (cache-only ≤300ms) | 'fast' | 'balanced' (default) | 'deep'.
- include_images / include_favicon: opt-in images[] + per-result favicon.
- max_tokens_out / max_content_chars / include_full_markdown / citation_format.
- force_refresh + mode ('cache' | 'default' | 'stealth').

Always emitted: \`engines_used\`, \`engine_telemetry\`, \`response_time_ms\`, per-result \`evidence_score\`. Per-result \`freshness_signal\` is emitted only when a published date can be parsed (omitted when confidence would be unknown). Brand-domain top-3 collision → \`brand_collision_warning\` with rewrites. \`query_understanding\` exposes intent/entities. Quote [N] or {citation_id}.`,

  crawl: `Crawl a site from a seed URL and return content from many pages. Use for indexing docs, wikis, multi-page references. Beats firecrawl-crawl for offline reuse: every page lands in the local cache.

Key parameters:
- strategy: "bfs" (default) | "dfs" | "sitemap" (fastest for doc sites) | "map" (URL-only discovery).
- max_depth: link-following depth (default 2).
- max_pages: page cap (default 20).
- include_patterns / exclude_patterns: regex filters on URLs.
- max_tokens_out / include_full_markdown / citation_format: budget + shape controls.

Returns pages[] with title, evidence, depth. Content is deduplicated across pages (anchor-fragment aware). All pages are cached for later \`cache\` / \`find_similar\` queries.`,

  cache: `Search previously fetched content without hitting the network. Run this BEFORE any search/fetch — cache hits return instantly with full markdown.

Key parameters:
- query: FTS5 full-text search over cached markdown + titles (supports AND, OR, NOT, "phrase").
- url_pattern: glob filter on URLs (e.g. "*example.com*").
- since: ISO date — only entries cached after this date.
- stats: true to get cache size, entry count, oldest/newest dates.
- clear: true to delete matching entries.

Persists across sessions. No remote round-trip.`,

  extract: `Extract structured data from a URL or raw HTML. Use for specific data points (tables, prices, schema fields) rather than whole-page markdown.

Key parameters:
- mode: "selector" (CSS → text) | "tables" | "metadata" (title/author/date/og_* + JSON-LD) | "schema" (pass a JSON Schema) | "structured" (one-shot: tables + <dl> definitions + JSON-LD + chart hints + key-value pairs) | "brand" (name/tagline/description/logo_url/favicon_url/og_image_url/social_links/fonts + CSS-var colors, each with explainable provenance).
- css_selector: required for mode="selector".
- schema: required for mode="schema".
- multiple: return all matches (mode="selector" only).

Prefer mode="structured" over chaining multiple extract calls — one response carries \`{ tables, definitions, jsonld, chart_hints, key_value_pairs }\`. chart_hints surfaces SVG titles, aria-labels, figcaptions for charts whose data is JS-rendered. Metadata parity with \`fetch\` (same og_/canonical_url shape). \`mode: "brand"\` walks JSON-LD Organization/Brand/WebSite → OG/Twitter Card meta → \`<link rel=icon>\` → CSS custom properties → heuristic header/footer DOM; \`provenance\` records the winning source. Provenance enums: logo ∈ {json-ld, og:logo, link[rel=icon], heuristic, unknown}; colors ∈ {css-vars, palette-extraction, unknown}; fonts ∈ {css-vars, css-rule, inline-style, google-fonts-link, unknown}. Honesty: \`name\` and \`logo_url\` are unset when no explicit source emits them — favicons never promote to \`logo_url\`. \`mode: "schema"\` is evidence-only: LLM-sourced fields not present in source text are returned as \`null\` with a warning.`,

  find_similar: `Find content related to a URL or concept. Best after a successful crawl/fetch — the local cache makes recommendations cheap. Concept-only queries on a cold cache often return 0-2 weak matches; warm the cache first via \`crawl\` / \`fetch\` for materially better results.

Key parameters:
- url: known-good page; its content + embeddings drive similarity.
- concept: free-text alternative to url. Thin cache → expect \`cold_start\` to fire.
- max_results: default 5.
- include_cached: true (default) to search cache first; false = web only.
- threshold: minimum fused score (0-1, default 0.5).
- include_ranking_debug: opt-in per-result \`ranking_debug\` { fts5_rank, embedding_rank, web_rank, rrf_score } so you can audit which signal won.
- max_tokens_out / include_full_markdown / citation_format: budget + shape controls.

Pass either url or concept. Three signals fused via RRF: keyword (FTS5), embeddings, optional live web. Each result carries \`match_signals\` with \`embedding_rank\`, \`fts5_rank\`, \`fused_score\`. When local signals are weak (cache empty, no hits, or concept mode returns only 1-2 cache matches), the response carries \`cold_start\` — pass it verbatim to the user (tune \`WIGOLO_FIND_SIMILAR_COLD_START_THRESHOLD\` to adjust).

Returns results[], method ("hybrid" | "embedding" | "fts5" | "search"), cache_hits, search_hits, embedding_available, total_time_ms.`,

  research: `Multi-step research on a complex question. Decomposes into sub-queries, searches in parallel, fetches sources, synthesizes a cited report. Beats chaining \`search\` + \`fetch\` manually for multi-source synthesis.

Key parameters:
- question: the research question.
- depth: 'quick' (~15s, 2 sub-queries) | 'standard' (~40s, 4 sub-queries, default) | 'comprehensive' (~80s, 7 sub-queries).
- max_sources: override per-depth source count.
- include_domains / exclude_domains: scope.
- schema: optional JSON Schema — structures the report.
- stream: progress notifications per phase.
- max_tokens_out / include_full_markdown / citation_format: budget + shape controls.

Returns report (markdown with [N]), citations[], sources[], sub_queries[], depth, total_time_ms, sampling_supported, and \`brief\` with \`topics\`, \`highlights\`, \`key_findings\`, \`sections\` (overview.cross_references, comparison, gaps — gaps lists any named sub-entity research could not corroborate).`,

  agent: `Natural-language data gathering across sources. Plans queries + URLs from a prompt, executes in parallel, optionally extracts structured fields, synthesizes. Full step transparency.

Key parameters:
- prompt: NL description of what to gather (e.g. "pricing for the top 5 CRM tools").
- urls: optional seed URLs.
- schema: optional JSON Schema — extracts matching fields from each page and merges.
- max_pages: default 10.
- max_time_ms: default 60000.
- stream: progress notifications per step.
- max_tokens_out / include_full_markdown / citation_format: budget + shape controls.

Pipeline: plan → search+fetch in parallel within budget → optional schema extraction → synthesize. \`steps[]\` exposes every action with timing. Uses MCP sampling when supported; falls back to keyword extraction otherwise.

Returns result, sources[], pages_fetched, steps[], total_time_ms, sampling_supported.`,

  diff: `Compute a diff between two markdown bodies or two URL fetches.

Key parameters:
- old: { url?, markdown?, content_hash? } — left-hand side. URL form reads from cache; cache miss returns a structured \`cache_miss\` error (no network re-fetch).
- new: { url?, markdown? } — right-hand side. Same cache rules as \`old\`.
- output: 'unified' (default, git-style patch) | 'hunks' (structured array) | 'summary' (line counts only).
- granularity: 'line' (default) | 'word' | 'section'. Section walks H1/H2/H3 boundaries and tags each hunk with \`section_title\`.

Returns \`{ changed, summary, unified_diff?|hunks?, truncated? }\`. \`summary\` always present (added/removed/modified lines + total_changed_chars). Above the 5000-line cap the engine emits \`truncated: true\` plus an approximate summary — never silently degrades.`,

  watch: `Schedule lazy re-checks of a URL and surface diffs on change. Persistent across sessions — jobs survive MCP server restarts.

LAZY EXECUTION — NOT CRON. There is no background daemon. Checks fire ONLY when:
  1. You explicitly call \`watch({ action: 'check', job_id })\`, OR
  2. Any OTHER wigolo tool runs and the job's interval has elapsed (overdue jobs are triggered fire-and-forget in the background).
A job on an idle MCP server will not fire until the next tool call. Do not expect cron-like accuracy.

Key parameters:
- action: 'create' | 'list' | 'check' | 'pause' | 'resume' | 'delete'.
- url (create-only): must be a public http/https URL. Loopback, RFC 1918 ranges, link-local, and non-http(s) schemes are rejected at registration.
- interval_seconds (create-only): minimum 60 — sub-minute polling is refused to respect target-site rate limits.
- selector (create-only, optional): CSS selector for future selector-scoped diffs. Persisted now for forward compatibility; the diff is currently full-page.
- notification (create-only, optional): 'inline' (default — change reports come back on the next \`action: 'check'\`) or a public webhook URL. Same SSRF guard as \`url\`. Webhook delivery is best-effort POST — no retry / no queue / no backoff.
- job_id (check/pause/resume/delete).

\`list\` returns each job's \`staleness_seconds\` so you can see how overdue each check is: negative = not yet due, positive = overdue by N seconds. Pair with \`action: 'check'\` to force one immediately.

Idempotent \`create\`: identical url + interval + selector returns the existing \`job_id\` — does not duplicate the row.`,
} as const;

export type ToolName = keyof typeof TOOL_DESCRIPTIONS;
