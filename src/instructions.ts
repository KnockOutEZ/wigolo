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

export const WIGOLO_INSTRUCTIONS = `Wigolo is a local-first web access layer: search the open web, fetch pages, crawl sites, and extract structured data. All results land in a local SQLite cache that persists across sessions.

## When to use which tool

- \`search\` — you need information on a topic but do not have a URL yet.
- \`fetch\` — you already have a specific URL to read.
- \`crawl\` — you need multiple pages from the same site (docs, wikis, references).
- \`cache\` — you want to know if the content is already on disk from an earlier read.
- \`extract\` — you need specific data points (tables, metadata, schema-shaped fields) rather than a whole page as markdown.
- \`find_similar\` — you have a URL or concept and want to discover related pages, both from the local cache and via web search.

## Check the cache before going to the network

Before every \`search\` or \`fetch\`, consider a \`cache\` call with the query text or URL pattern. Pages read in this or a prior session return instantly with their full markdown — no network, no rate limits.

## Pick the right strategy

- For documentation sites, prefer \`crawl\` with \`strategy: "sitemap"\` — it is faster and more complete than BFS because it reads sitemap.xml directly.
- When you only need to discover what pages exist on a site, use \`crawl\` with \`strategy: "map"\`. It returns URLs only, no content, and is far cheaper than a full crawl. Follow up with targeted \`fetch\` calls.
- For structured data (prices, specs, listings, table rows), use \`extract\` with \`mode: "schema"\` or \`mode: "tables"\`. Reach for \`fetch\` only when you want the whole page as markdown.

## Scope searches, do not just broaden queries

\`search\` accepts \`include_domains\` (e.g. \`["react.dev", "developer.mozilla.org"]\`) and a \`category\` such as \`"docs"\`, \`"code"\`, \`"news"\`, or \`"papers"\`. A scoped query usually beats a broader query with post-filtering.

## Performance

- \`max_results: 3\` for focused lookups; \`5\` is the default; \`10+\` only for broad research.
- \`fetch\` with \`section: "Heading Name"\` returns just the content under that heading. Cheaper and more relevant than the whole page.
- Repeated fetches of the same URL are free — served directly from the SQLite cache.

## Capabilities worth knowing

- Localhost URLs work: \`http://localhost:3000\`, \`http://127.0.0.1:8080\`, and similar. Useful for reading local dev servers and internal docs.
- \`use_auth: true\` on \`fetch\` and \`crawl\` reuses the user's configured browser session for pages behind a login.
- \`cache\` accepts FTS5 query syntax (\`AND\`, \`OR\`, \`NOT\`, \`"exact phrase"\`) for precise lookups.
- \`crawl\` accepts regex \`include_patterns\` and \`exclude_patterns\` to stay inside a section of a large site.`;

export const TOOL_DESCRIPTIONS = {
  fetch: `Fetch a single URL and return clean markdown. Use when you have a specific URL to read. Automatically detects if JavaScript rendering is needed.

Key parameters:
- section: extract content under a specific heading (e.g., section: "API Reference") — faster than reading the whole page
- use_auth: true to use stored browser session for authenticated/private pages
- render_js: "auto" (default, detects JS need), "always" (force browser), "never" (HTTP only, fastest)
- headers: custom HTTP headers if needed

Returns title, markdown content, links, images, and metadata. Result is cached locally — subsequent fetches of the same URL return instantly. Works with localhost URLs (localhost:3000, etc.) for reading local dev servers.`,

  search: `Search the web and return full markdown content from top results. Use for finding information on any topic — returns extracted page content, not just snippets. Accepts a single query string or an array of query variants for parallel multi-query search with deduplication and reranking.

Key parameters:
- query: string or string[] — pass an array for multi-perspective search (e.g., ["react hooks tutorial", "useEffect best practices"])
- include_domains/exclude_domains: scope results to specific sites (e.g., include_domains: ["react.dev"])
- category: "general", "news", "code", "docs", "papers" — filters by content type
- from_date/to_date: ISO dates for time-bounded queries
- max_results: default 5. Use 3 for focused queries, 10+ for research.

Results include title, URL, relevance_score, and full markdown_content per result. Previously fetched pages are served from local cache.`,

  crawl: `Crawl a website starting from a URL and return content from multiple pages. Use for indexing documentation sites, wikis, or any multi-page resource.

Key parameters:
- strategy: "bfs" (breadth-first, default), "dfs" (depth-first), "sitemap" (use sitemap.xml — fastest for doc sites), "map" (URL discovery only, no content — fastest for scoping a site)
- max_depth: how many links deep to follow (default 2)
- max_pages: maximum pages to fetch (default 20)
- include_patterns/exclude_patterns: regex filters on URLs

Returns an array of pages with title, markdown, and depth. Content is deduplicated across pages (repeated nav/headers/footers stripped). All pages are cached for later cache queries.`,

  cache: `Search previously fetched content without hitting the network. Use before searching the web — if relevant content was already fetched or crawled, this returns it instantly.

Key parameters:
- query: full-text search over cached markdown and titles (supports FTS5 syntax: AND, OR, NOT, "phrase match")
- url_pattern: glob filter on URLs (e.g., "*react.dev*")
- since: ISO date — only results cached after this date
- stats: true to get cache size, entry count, oldest/newest dates
- clear: true to delete matching entries

Returns matching cached pages with full markdown content. Cache persists across sessions in local SQLite.`,

  extract: `Extract structured data from a URL or raw HTML. Use when you need specific data points, tables, or metadata rather than full page markdown.

Key parameters:
- mode: "selector" (CSS selector → text), "tables" (HTML tables → JSON rows), "metadata" (title/author/date/description), "schema" (JSON Schema → heuristic field extraction)
- css_selector: required for mode="selector" — any valid CSS selector
- schema: for mode="schema", a JSON Schema object describing the fields to extract
- multiple: true to return array of all matches (mode="selector" only)

For mode="tables", returns array of table objects with headers and row data. For mode="schema", pass { price: "string", name: "string" } and get structured fields extracted from the page.`,

  find_similar: `Find pages semantically similar to a given URL or concept. Uses hybrid search combining local cache (FTS5) and web search with Reciprocal Rank Fusion.

Key parameters:
- url: find pages similar to this URL (page is analyzed for key terms)
- concept: find pages about this topic (use when no URL is available)
- include_cache/include_web: control which sources to search (both default true)
- include_domains/exclude_domains: scope results to specific sites

Returns ranked results with match signals showing how each result was found. Best used after building up a cache via fetch/crawl — the more cached content, the better the local similarity matching.`,
} as const;

export type ToolName = keyof typeof TOOL_DESCRIPTIONS;
