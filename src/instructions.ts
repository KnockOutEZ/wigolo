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

export const WIGOLO_INSTRUCTIONS = `Wigolo is a local-first web access layer: search the open web, fetch pages, crawl sites, extract structured data, find related content, run multi-step research, and execute agent-driven data gathering. All results land in a local knowledge cache that persists across sessions.

## Host-LLM synthesis pattern (read this first)

Wigolo has no internal LLM. It returns *structured evidence* so YOU (the host LLM) write the final answer. Fold structure into your reply:

- \`search\` \`format: "highlights"\` → ML-scored passages + \`citations\`. Quote [N].
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
| Direct quote | \`search\` | \`format: "highlights"\` returns ML-scored passages with citations; cite [N] in your reply |
| Direct answer | \`search\` | \`format: "answer"\` if client supports sampling, else falls back to \`highlights\` (not plain context) |
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

## Performance

- \`max_results: 3\` for focused lookups; \`5\` default; \`10+\` only for broad research.
- \`max_content_chars: 3000\` on \`search\` or \`fetch\` smart-truncates each result's markdown at a paragraph/heading boundary with a \`[... content truncated]\` marker. Keeps context compact for AI agents. Prefer this over raw \`max_chars\` slicing.
- \`fetch\` with \`section: "Heading Name"\` returns content under that heading -- cheaper than the whole page.
- Repeated fetches of the same URL are free (local cache).
- \`research\` with \`depth: "quick"\` (~15s) suits most factual questions; reserve \`"comprehensive"\` for deep investigation.
- \`agent\` respects \`max_pages\` (default 10) and \`max_time_ms\` (default 60s).

## Extras

- Localhost URLs (\`localhost:3000\`, \`127.0.0.1:8080\`) work for local dev servers.
- \`use_auth: true\` on \`fetch\`/\`crawl\` reuses browser session for logged-in pages.
- \`cache\` supports full-text search syntax (\`AND\`, \`OR\`, \`NOT\`, \`"phrase"\`).
- \`research\`/\`agent\` use MCP sampling when supported; fall back to structured data for host-LLM synthesis.`;

export const TOOL_DESCRIPTIONS = {
  fetch: `Fetch a single URL and return clean markdown. Use when you have a specific URL to read. Automatically detects if JavaScript rendering is needed.

Key parameters:
- section: extract content under a specific heading (e.g., section: "API Reference") -- faster than reading the whole page
- max_content_chars: smart-truncate markdown at a paragraph/heading boundary with a \`[... content truncated]\` marker (e.g., 3000 for compact context). Preferred over max_chars for AI agents.
- use_auth: true to use stored browser session for authenticated/private pages
- render_js: "auto" (default, detects JS need), "always" (force browser), "never" (HTTP only, fastest)
- headers: custom HTTP headers if needed
- force_refresh: true to bypass cache and fetch fresh content from the network

Returns title, markdown, links, images, metadata (og_image, og_type, canonical_url, keywords). Decorative images filtered, relative URLs resolved. Cached locally; repeat fetches are instant. Localhost URLs work.

Use force_refresh: true for frequently changing content. Default serves from cache.`,

  search: `Search the web and return full markdown content from top results. Returns extracted page content, not just snippets.

Key parameters:
- query: string or string[] array (3-5 keyword variants for broader coverage; deduplicated automatically)
- include_domains/exclude_domains: scope to specific sites. ALWAYS scope library/framework queries.
- category: "general" | "news" | "code" | "docs" | "papers" — coarse filter, pair with include_domains.
- from_date/to_date: ISO YYYY-MM-DD for time-bounded queries
- max_results: default 5; use 3 for focused, 10+ for research
- format: "full" (default), "context", "highlights" (ML-scored passages + [N] citations), "answer" (sampling synthesis; falls back to highlights), "stream_answer"
- max_highlights: cap highlights count (default 10)
- max_content_chars: smart-truncate markdown at paragraph boundary (e.g., 3000)
- force_refresh: true to bypass all caches

"answer" falls back to "highlights" when sampling unsupported (most clients). Results include title, URL, relevance_score, and full markdown_content. Cache serves previously fetched pages instantly.`,

  crawl: `Crawl a website starting from a URL and return content from multiple pages. Use for indexing documentation sites, wikis, or any multi-page resource.

Key parameters:
- strategy: "bfs" (breadth-first, default), "dfs" (depth-first), "sitemap" (use sitemap.xml -- fastest for doc sites), "map" (URL discovery only, no content -- fastest for scoping a site)
- max_depth: how many links deep to follow (default 2)
- max_pages: maximum pages to fetch (default 20)
- include_patterns/exclude_patterns: regex filters on URLs

Returns an array of pages with title, markdown, and depth. Content is deduplicated across pages (repeated nav/headers/footers stripped). All pages are cached for later cache queries.`,

  cache: `Search previously fetched content without hitting the network. Use before searching the web -- if relevant content was already fetched or crawled, this returns it instantly.

Key parameters:
- query: full-text search over cached markdown and titles (supports AND, OR, NOT, "phrase match")
- url_pattern: glob filter on URLs (e.g., "*example.com*")
- since: ISO date -- only results cached after this date
- stats: true to get cache size, entry count, oldest/newest dates
- clear: true to delete matching entries

Returns matching cached pages with full markdown content. Cache persists across sessions locally.`,

  extract: `Extract structured data from a URL or raw HTML. Use when you need specific data points, tables, or metadata rather than full page markdown.

Key parameters:
- mode: "selector" (CSS selector -> text), "tables" (HTML tables only), "metadata" (title/author/date/description/og_* + JSON-LD), "schema" (JSON Schema -> heuristic field extraction), "structured" (ONE-SHOT: tables + <dl> definitions + JSON-LD + chart hints from SVG/figure + microdata/data-attr/grid key-value pairs)
- css_selector: required for mode="selector" -- any valid CSS selector
- schema: for mode="schema", a JSON Schema object describing the fields to extract
- multiple: true to return array of all matches (mode="selector" only)

Prefer mode="structured" over chaining multiple extract calls — it returns every structured pattern on the page in one response:
  { tables, definitions, jsonld, chart_hints, key_value_pairs }

chart_hints surfaces SVG titles, aria-labels, and figcaptions — host LLMs use these to describe data visualizations even when the underlying data is rendered by JavaScript.

For mode="tables", returns array of table objects with headers and row data. For mode="schema", pass { price: "string", name: "string" } and get structured fields extracted from the page.`,

  find_similar: `Find content related to a URL or concept. Use when you have a known-good page or topic and want to discover similar resources from the cache or web.

Key parameters:
- url: a URL to find content similar to. The page's content and embeddings are used for similarity matching.
- concept: free-text description of what you want similar content for. Use when you do not have a specific URL.
- max_results: number of similar items to return (default 5)
- include_cached: true (default) to search the local cache first, false to skip cache and search the web only
- threshold: minimum similarity score (0-1, default 0.5) -- higher values return fewer, more relevant results

Provide either url or concept (not both). Results are fused from three signals via 3-way RRF: keyword match, semantic embeddings, and (if local hits are sparse) a live web search. Each result carries \`match_signals\` with \`embedding_rank\`, \`fts5_rank\`, and \`fused_score\` so you can explain ranking to the user.

The response may include a \`cold_start\` string when local signals are weak (empty cache, embeddings unavailable, < 20 cached pages). Pass this verbatim to the user — it explains why results came from web search and how to warm the cache.

Returns results array, method used ("hybrid" | "embedding" | "fts5" | "search"), cache_hits, search_hits, embedding_available, and total_time_ms.`,

  research: `Run multi-step research on a complex question. Decomposes the question into sub-queries, searches in parallel, fetches top sources, and synthesizes a report with citations.

Key parameters:
- question: the research question to investigate
- depth: "quick" (~15s, 2 sub-queries, 5-8 sources), "standard" (~40s, 4 sub-queries, 10-15 sources, default), "comprehensive" (~80s, 7 sub-queries, 20-25 sources)
- max_sources: override the default source count for the chosen depth
- include_domains/exclude_domains: scope research to specific sites
- schema: optional JSON Schema -- structures the report to extract matching fields
- stream: true to receive progress notifications as each phase completes

Returns report (markdown with [N] citations), citations array, sources, sub_queries, depth, total_time_ms, sampling_supported, and brief (topics, highlights, key_findings, sections.overview/comparison/gaps).`,

  agent: `Execute a natural-language data gathering task. Plans search queries and URLs from a prompt, executes them in parallel, and synthesizes results. Full step transparency.

Key parameters:
- prompt: natural-language description of what data to gather (e.g., "find pricing for the top 5 CRM tools")
- urls: optional array of specific URLs to include in the gathering
- schema: optional JSON Schema -- if provided, extracts structured data matching the schema from each page and merges results
- max_pages: maximum pages to fetch (default 10)
- max_time_ms: maximum execution time in milliseconds (default 60000)
- stream: true to receive progress notifications as each step completes

The pipeline: (1) plan -- interpret prompt to determine search queries and URLs to visit, (2) execute -- run searches and fetch URLs in parallel within budget, (3) extract -- if schema provided, apply schema extraction to each page and merge, (4) synthesize -- produce natural-language or structured result.

The steps array in the output provides full transparency into every action taken (plan, search, fetch, extract, synthesize) with timing. This differentiates from black-box alternatives.

Uses MCP requestSampling for planning and synthesis. Without sampling support, uses keyword extraction for planning and returns raw content.

Returns result (string or structured object), sources array, pages_fetched count, steps array with action/detail/time_ms, total_time_ms, and sampling_supported flag.`,
} as const;

export type ToolName = keyof typeof TOOL_DESCRIPTIONS;
