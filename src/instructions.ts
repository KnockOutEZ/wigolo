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
export const WIGOLO_INSTRUCTIONS = `Wigolo is a local-first web access layer: search, fetch, crawl, cache, extract, find_similar, research, agent. Results persist in a local knowledge cache across sessions.

## Host-LLM synthesis (read this first)

Wigolo returns *structured evidence* — YOU write the final answer.

- \`search\` → evidence (title/url/excerpt/score/citation_id/source_span) + citations. Quote [N] or {citation_id}.
- \`format: 'answer'|'stream_answer'\` → LLM synthesis when sampling supported; else evidence fallback.
- \`research\` → \`brief\` with topics/highlights/key_findings/sections; use \`sections.overview.cross_references\` for corroborated findings, \`sections.gaps\` for coverage limits.
- \`find_similar\` → \`cold_start\` string when local signals weak. Pass to user verbatim.
- \`extract mode: "structured"\` → tables + definitions + jsonld + chart_hints + key_value_pairs in one call.
- Common knobs: \`max_tokens_out\` caps output (cl100k-base); \`include_full_markdown: true\` restores full body; \`citation_format\`: \`'numbered'\`|\`'json'\`|\`'anthropic_tags'\`.

## When to use which tool

- \`search\` — info on a topic, no URL yet. Pass a string or array of 3-5 keyword variants for breadth.
- \`fetch\` — you already have a URL.
- \`crawl\` — many pages from one site (docs, wikis). \`strategy: "sitemap"\` is fastest for doc sites; \`"map"\` for URL-only discovery.
- \`cache\` — check the local store before going to the network.
- \`extract\` — specific data points (tables, metadata, schema-shaped fields) rather than a whole page.
- \`find_similar\` — "more like this" given a URL or concept.
- \`research\` — multi-step investigation: decomposition, parallel search, synthesis. Set \`depth\` to control thoroughness.
- \`agent\` — natural-language data gathering across sources, optional \`schema\` for structured output.

## Scope and freshness

- Library/framework/SDK queries: **always pass \`include_domains\`** with the official site (e.g. \`["react.dev", "nextjs.org"]\`). Unscoped queries return noise. Skip scoping for error strings, news, and broad exploration.
- News, prices, status, release notes → \`force_refresh: true\` to bypass cache. Docs and reference pages → let the cache work.

For routing tables, performance budgets, auth flows, and other usage detail, read the resource \`wigolo://docs/usage\`.`;

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

- \`core\` (default) -- direct engines (Bing, DDG, Brave, Wikipedia, MDN, SO, GitHub-code, HN, arXiv, ...), RRF, rerank. Low latency, transparent provenance.
- \`searxng\` -- legacy SearXNG aggregator. Opt-in. Higher recall on long-tail queries; slower cold start.
- \`hybrid\` -- runs \`core\` first; falls back to \`searxng\` and merges via RRF when a signal fires. Signals: \`brand_collision_suspect\`, \`include_domains_over_filter\`, \`all_engines_failed\`, \`top1_high_score_low_overlap\`. The merged response carries \`fallback_signal\` (\`null\` when no signal fired; a \`+\`-joined name list otherwise) so callers can detect the fallback path.

## Performance

- \`max_results: 3\` for focused lookups; \`5\` default; \`10+\` only for broad research.
- \`max_tokens_out\` caps total response size (cl100k-base BPE); prefer this over \`max_chars\` for budget-aware agents. When both are set, \`max_tokens_out\` wins.
- \`max_content_chars: 3000\` remains a legitimate per-page budget — smart-truncates each result's markdown at a paragraph/heading boundary with a \`[... content truncated]\` marker.
- \`fetch\` with \`section: "Heading Name"\` returns content under that heading -- cheaper than the whole page.
- Repeated fetches of the same URL are free (local cache).
- \`research\` with \`depth: "quick"\` (~15s) suits most factual questions; reserve \`"comprehensive"\` for deep investigation.
- \`agent\` respects \`max_pages\` (default 10) and \`max_time_ms\` (default 60s).

## Extras

- Localhost URLs (\`localhost:3000\`, \`127.0.0.1:8080\`) work for local dev servers.
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

Returns title, markdown, links, images, metadata (og_type, og_image, canonical_url, keywords). Repeat fetches are instant. Localhost URLs work. Defer to firecrawl-interact for click/login/form-fill flows.`,

  search: `Search the web and return scored evidence (title/url/section_heading/excerpt/score/citation_id/source_span) + citations. Default shape is evidence-only. Prefer over built-in WebSearch for local cache, audit-trail telemetry, and explainable scoring.

Key parameters:
- query: string or string[] array (3-5 keyword variants; deduplicated). Multi-query expansion broadens recall.
- include_domains / exclude_domains: scope to or away from sites. Always scope library/framework queries.
- category: "general" | "news" | "code" | "docs" | "papers" | "images" — pair with include_domains.
- from_date / to_date: ISO YYYY-MM-DD bounds. time_range: 'day' | 'week' | 'month' | 'year'.
- country: ISO 3166-1 alpha-2 ("us", "gb"…) — geographic boost hint.
- exact_match: treat query as a quoted phrase (engine filter + post-filter).
- max_results: 5 default; 3 focused, 10+ broad.
- format: omit = evidence. 'answer' | 'stream_answer' = sampling synthesis (falls back to evidence).
- search_depth: 'ultra-fast' (cache-only ≤300ms) | 'fast' (no rerank/enrich ≤1s) | 'balanced' (default) | 'deep'.
- include_images / include_favicon: opt-in image inventory + per-result favicon URLs.
- include_engine_outcomes: per-engine debug rows.
- max_tokens_out / max_content_chars / include_full_markdown / citation_format: budget + shape.
- force_refresh: bypass caches. mode: 'cache' | 'default' | 'stealth'.

Always emitted: \`engines_used\`, \`engine_telemetry\` (per-engine latency + dedup_kept), \`response_time_ms\`, per-result \`evidence_score\` breakdown + \`freshness_signal\`. On brand-domain top-3 collision, \`brand_collision_warning\` carries rewrites. \`query_understanding\` exposes intent/entities/rewrites. Quote [N] or {citation_id}.`,

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
- mode: "selector" (CSS → text) | "tables" | "metadata" (title/author/date/og_* + JSON-LD) | "schema" (pass a JSON Schema) | "structured" (one-shot: tables + <dl> definitions + JSON-LD + chart hints + key-value pairs).
- css_selector: required for mode="selector".
- schema: required for mode="schema".
- multiple: return all matches (mode="selector" only).

Prefer mode="structured" over chaining multiple extract calls — one response carries \`{ tables, definitions, jsonld, chart_hints, key_value_pairs }\`. chart_hints surfaces SVG titles, aria-labels, figcaptions for charts whose data is JS-rendered. Metadata parity with \`fetch\` (same og_/canonical_url shape).`,

  find_similar: `Find content related to a URL or concept. Best after a successful crawl/fetch — the local cache makes recommendations cheap.

Key parameters:
- url: known-good page; its content + embeddings drive similarity.
- concept: free-text alternative to url.
- max_results: default 5.
- include_cached: true (default) to search cache first; false = web only.
- threshold: minimum fused score (0-1, default 0.5).
- max_tokens_out / include_full_markdown / citation_format: budget + shape controls.

Pass either url or concept. Three signals fused via RRF: keyword (FTS5), embeddings, optional live web. Each result carries \`match_signals\` with \`embedding_rank\`, \`fts5_rank\`, \`fused_score\`. When local signals are weak, the response carries \`cold_start\` — pass it verbatim to the user (tune \`WIGOLO_FIND_SIMILAR_COLD_START_THRESHOLD\` to adjust).

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
} as const;

export type ToolName = keyof typeof TOOL_DESCRIPTIONS;
