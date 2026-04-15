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

export const WIGOLO_INSTRUCTIONS = `Wigolo is a local-first web access layer: search the open web, fetch pages, crawl sites, extract structured data, find related content, run multi-step research, and execute agent-driven data gathering. All results land in a local SQLite cache that persists across sessions.

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
| Documentation lookup | \`search\` | \`include_domains: ["react.dev", "docs.python.org"]\`, \`category: "docs"\` |
| Error debugging | \`search\` | exact error string as query, \`category: "code"\` |
| Library research | \`crawl\` | seed URL of docs site, \`strategy: "sitemap"\`, then \`cache\` for later queries |
| Related content | \`find_similar\` | \`url\` of a known good page, or \`concept\` as free text |
| Direct answer | \`search\` | \`format: "answer"\` for a synthesized direct response |
| Comprehensive research | \`research\` | \`depth: "comprehensive"\`, optional \`include_domains\` to scope |
| Data gathering | \`agent\` | natural-language \`prompt\`, optional \`schema\` for structured output |
| Structured extraction | \`extract\` | \`mode: "schema"\` with a JSON Schema, or \`mode: "tables"\` |
| Site inventory | \`crawl\` | \`strategy: "map"\` for URL-only discovery, no content fetched |

## Check the cache before going to the network

Before every \`search\` or \`fetch\`, consider a \`cache\` call with the query text or URL pattern. Pages read in this or a prior session return instantly with their full markdown -- no network, no rate limits. The \`research\` and \`agent\` tools check the cache internally, so you do not need a separate call for those.

## Multi-query search strategy

For broad or exploratory queries, pass an array of 3-5 semantically varied keyword forms rather than a single natural-language question. Example: instead of "how does React handle state management", pass \`["react state management", "useState useReducer patterns", "react hooks state", "react context vs redux"]\`. The search tool deduplicates across sub-queries automatically.

## Pick the right strategy

- For documentation sites, prefer \`crawl\` with \`strategy: "sitemap"\` -- it is faster and more complete than BFS because it reads sitemap.xml directly.
- When you only need to discover what pages exist on a site, use \`crawl\` with \`strategy: "map"\`. It returns URLs only, no content, and is far cheaper than a full crawl. Follow up with targeted \`fetch\` calls.
- For structured data (prices, specs, listings, table rows), use \`extract\` with \`mode: "schema"\` or \`mode: "tables"\`. Reach for \`fetch\` only when you want the whole page as markdown.
- For complex questions requiring synthesis from multiple sources, use \`research\` instead of manually chaining \`search\` + \`fetch\` calls.
- For natural-language data gathering tasks ("find the pricing for the top 5 CRM tools"), use \`agent\` with an optional \`schema\` to structure the output.

## Scope searches, do not just broaden queries

\`search\` accepts \`include_domains\` (e.g. \`["react.dev", "developer.mozilla.org"]\`) and a \`category\` such as \`"docs"\`, \`"code"\`, \`"news"\`, or \`"papers"\`. A scoped query usually beats a broader query with post-filtering.

## Performance

- \`max_results: 3\` for focused lookups; \`5\` is the default; \`10+\` only for broad research.
- \`fetch\` with \`section: "Heading Name"\` returns just the content under that heading. Cheaper and more relevant than the whole page.
- Repeated fetches of the same URL are free -- served directly from the SQLite cache.
- \`research\` with \`depth: "quick"\` is fast (~15s) and sufficient for most factual questions. Reserve \`"comprehensive"\` for topics requiring deep investigation.
- \`agent\` respects \`max_pages\` (default 10) and \`max_time_ms\` (default 60s) to bound resource usage.

## Capabilities worth knowing

- Localhost URLs work: \`http://localhost:3000\`, \`http://127.0.0.1:8080\`, and similar. Useful for reading local dev servers and internal docs.
- \`use_auth: true\` on \`fetch\` and \`crawl\` reuses the user's configured browser session for pages behind a login.
- \`cache\` accepts FTS5 query syntax (\`AND\`, \`OR\`, \`NOT\`, \`"exact phrase"\`) for precise lookups.
- \`crawl\` accepts regex \`include_patterns\` and \`exclude_patterns\` to stay inside a section of a large site.
- \`find_similar\` uses cached embeddings when available -- no network call needed if the content has been seen before.
- \`research\` and \`agent\` use MCP requestSampling for intelligent decomposition and synthesis when the client supports it. Without sampling support, they return raw sources in context format.`;

export const TOOL_DESCRIPTIONS = {
  fetch: `Fetch a single URL and return clean markdown. Use when you have a specific URL to read. Automatically detects if JavaScript rendering is needed.

Key parameters:
- section: extract content under a specific heading (e.g., section: "API Reference") -- faster than reading the whole page
- use_auth: true to use stored browser session for authenticated/private pages
- render_js: "auto" (default, detects JS need), "always" (force browser), "never" (HTTP only, fastest)
- headers: custom HTTP headers if needed

Returns title, markdown content, links, images, and metadata. Result is cached locally -- subsequent fetches of the same URL return instantly. Works with localhost URLs (localhost:3000, etc.) for reading local dev servers.`,

  search: `Search the web and return full markdown content from top results. Use for finding information on any topic -- returns extracted page content, not just snippets.

Key parameters:
- query: a search string, or an array of 3-5 semantically varied keyword forms for broader coverage. Arrays are deduplicated and merged automatically.
- include_domains/exclude_domains: scope results to specific sites (e.g., include_domains: ["react.dev"])
- category: "general", "news", "code", "docs", "papers" -- filters by content type
- from_date/to_date: ISO dates for time-bounded queries
- max_results: default 5. Use 3 for focused queries, 10+ for research.
- format: "full" (default, structured JSON), "context" (single token-budgeted string for LLM injection), "answer" (synthesized direct answer via requestSampling), "stream_answer" (same as answer, with MCP progress notifications emitted between pipeline phases)

The "answer" format uses the MCP client's sampling capability to synthesize a direct response from search results. If sampling is not supported, falls back to "context" format. "stream_answer" emits notifications/progress messages at each pipeline phase (search, fetch, synthesize) when the client provides a progressToken via request._meta — token-level streaming of the LLM response is not supported by MCP sampling, so the answer itself still arrives as one block.

Results include title, URL, relevance_score, and full markdown_content per result. Previously fetched pages are served from local cache.`,

  crawl: `Crawl a website starting from a URL and return content from multiple pages. Use for indexing documentation sites, wikis, or any multi-page resource.

Key parameters:
- strategy: "bfs" (breadth-first, default), "dfs" (depth-first), "sitemap" (use sitemap.xml -- fastest for doc sites), "map" (URL discovery only, no content -- fastest for scoping a site)
- max_depth: how many links deep to follow (default 2)
- max_pages: maximum pages to fetch (default 20)
- include_patterns/exclude_patterns: regex filters on URLs

Returns an array of pages with title, markdown, and depth. Content is deduplicated across pages (repeated nav/headers/footers stripped). All pages are cached for later cache queries.`,

  cache: `Search previously fetched content without hitting the network. Use before searching the web -- if relevant content was already fetched or crawled, this returns it instantly.

Key parameters:
- query: full-text search over cached markdown and titles (supports FTS5 syntax: AND, OR, NOT, "phrase match")
- url_pattern: glob filter on URLs (e.g., "*example.com*")
- since: ISO date -- only results cached after this date
- stats: true to get cache size, entry count, oldest/newest dates
- clear: true to delete matching entries

Returns matching cached pages with full markdown content. Cache persists across sessions in local SQLite.`,

  extract: `Extract structured data from a URL or raw HTML. Use when you need specific data points, tables, or metadata rather than full page markdown.

Key parameters:
- mode: "selector" (CSS selector -> text), "tables" (HTML tables -> JSON rows), "metadata" (title/author/date/description), "schema" (JSON Schema -> heuristic field extraction)
- css_selector: required for mode="selector" -- any valid CSS selector
- schema: for mode="schema", a JSON Schema object describing the fields to extract
- multiple: true to return array of all matches (mode="selector" only)

For mode="tables", returns array of table objects with headers and row data. For mode="schema", pass { price: "string", name: "string" } and get structured fields extracted from the page.`,

  find_similar: `Find content related to a URL or concept. Use when you have a known-good page or topic and want to discover similar resources from the cache or web.

Key parameters:
- url: a URL to find content similar to. The page's content and embeddings are used for similarity matching.
- concept: free-text description of what you want similar content for. Use when you do not have a specific URL.
- max_results: number of similar items to return (default 5)
- include_cached: true (default) to search the local cache first, false to skip cache and search the web only
- threshold: minimum similarity score (0-1, default 0.5) -- higher values return fewer, more relevant results

Provide either url or concept (not both). Results are ranked by cosine similarity of embeddings. Cached content with embeddings is searched first for instant results. If fewer than max_results are found in cache, a web search supplements the results.

Returns title, URL, similarity_score, and markdown_content per result.`,

  research: `Run multi-step research on a complex question. Decomposes the question into sub-queries, searches in parallel, fetches top sources, and synthesizes a report with citations.

Key parameters:
- question: the research question to investigate
- depth: "quick" (~15s, 2 sub-queries, 5-8 sources), "standard" (~40s, 4 sub-queries, 10-15 sources, default), "comprehensive" (~80s, 7 sub-queries, 20-25 sources)
- max_sources: override the default source count for the chosen depth
- include_domains/exclude_domains: scope research to specific sites
- schema: optional JSON Schema -- if provided, the report is structured to extract fields matching the schema
- stream: true to receive progress notifications as each research phase completes

The pipeline: (1) decompose question into sub-queries, (2) parallel search across sub-queries, (3) fetch and extract top unique sources, (4) synthesize report with citations from all sources, (5) optionally structure report fields if schema is provided.

Uses MCP requestSampling for intelligent decomposition and synthesis. Without sampling support, returns raw sources in context format with sampling_supported: false.

Returns report (markdown), citations array, sources with full content, sub_queries used, depth level, and total_time_ms.`,

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
