---
name: wigolo
description: Local-first web search MCP server for AI coding agents. Search, fetch, crawl, cache, extract, find similar pages, deep research, and autonomous agent mode with zero API keys.
author: KnockOutEZ
license: BUSL-1.1
repository: https://github.com/KnockOutEZ/wigolo
transport: stdio
install: npx @staticn0va/wigolo
runtime: node
min_runtime_version: "20"
tools:
  - name: search
    description: Search the web and return results with optional full content extraction. Supports domain filtering, date ranges, categories, and ML reranking.
  - name: fetch
    description: Fetch a web page and return its content as clean markdown. Supports JavaScript rendering, authenticated browsing, section extraction, and caching.
  - name: crawl
    description: Crawl a website starting from a seed URL. Supports BFS, DFS, sitemap, and map (URL-only) strategies with depth/page limits and URL filtering.
  - name: cache
    description: Query the local knowledge base of previously fetched content. Full-text search over cached pages by query, URL pattern, or date. Cache stats and clearing.
  - name: extract
    description: Extract structured data from a web page. CSS selector extraction, HTML table parsing, metadata extraction (title, author, JSON-LD), and JSON Schema heuristic matching.
  - name: find_similar
    description: Find pages semantically similar to a given URL or concept. Uses cached embeddings and web search to discover related content.
  - name: research
    description: Deep multi-step research on a question. Decomposes into sub-queries, searches in parallel, fetches sources, and synthesizes a report with citations.
  - name: agent
    description: Autonomous data gathering agent. Plans search queries from a prompt, fetches pages within budget, optionally extracts structured data via JSON Schema, and synthesizes results.
---

# wigolo

Local-first web search MCP server for AI coding agents.

## Installation

**Claude Code:**
```bash
claude mcp add wigolo -- npx @staticn0va/wigolo
```

**Cursor / VS Code / any MCP client:**
```json
{
  "mcpServers": {
    "wigolo": {
      "command": "npx",
      "args": ["@staticn0va/wigolo"]
    }
  }
}
```

**Optional warmup (improves search quality):**
```bash
npx @staticn0va/wigolo warmup
```

## Tools

### search
Search the web and get full markdown content in one call.
```json
{ "query": "React Server Components best practices", "max_results": 5, "include_domains": ["react.dev"] }
```

### fetch
Fetch any URL and get clean markdown.
```json
{ "url": "https://docs.react.dev/reference/react/useState", "section": "Parameters" }
```

### crawl
Crawl a site from a seed URL.
```json
{ "url": "https://docs.example.com", "strategy": "sitemap", "max_pages": 50 }
```

### cache
Query previously fetched content without hitting the network.
```json
{ "query": "React hooks", "url_pattern": "*react.dev*" }
```

### extract
Structured data extraction from any URL or HTML.
```json
{ "url": "https://example.com/product", "mode": "schema", "schema": { "type": "object", "properties": { "price": { "type": "string" }, "name": { "type": "string" } } } }
```

### find_similar
Find pages related to a URL or concept.
```json
{ "url": "https://react.dev/reference/react/useState", "max_results": 5 }
```

### research
Deep multi-step research that plans queries, fetches, and synthesizes.
```json
{ "question": "How do modern bundlers handle tree-shaking of ESM vs CJS", "depth": "standard", "max_sources": 10 }
```

### agent
Autonomous data gathering from a natural-language prompt.
```json
{ "prompt": "Compare authentication strategies of Supabase, Firebase, and Clerk", "max_pages": 15, "max_time_ms": 90000 }
```

## Workflow Patterns

Use the right tool for the right situation.

**When you know the URL** -- use `fetch`. One URL, clean markdown. Add `section` to read only the heading you need.

**When you need to find information** -- use `search`. Formulate a keyword query (not a natural language question). Scope with `include_domains` and `category` when you know where the answer lives.

**When you need multiple pages from one site** -- use `crawl`. For documentation sites, use `strategy: "sitemap"`. When you just want to discover what pages exist, use `strategy: "map"` (URL list only) then follow up with targeted `fetch` calls.

**When you need structured data** -- use `extract` with `mode: "tables"` or `mode: "schema"`. Do not use `fetch` when you need prices, specs, or table rows.

**When you already have content and want related pages** -- use `find_similar`. It searches the local cache by semantic similarity. No network calls needed.

**When you need a thorough answer on a complex topic** -- use `research`. It plans multiple search queries, fetches sources, and produces a cited synthesis. Prefer this over running 5+ manual search/fetch cycles.

**When the task requires multi-step data gathering** -- use `agent`. It breaks prompts into search queries and URL fetches, respects page and time budgets, and can extract structured data via JSON Schema.

**Before any network call** -- check `cache` first. Pages from prior sessions are still there. A cache hit is instant and free.

## Parameter Optimization

### search
- `max_results: 3` for focused lookups, `5` for exploration (default), `10+` for broad research
- `include_domains` narrows to trusted sources -- always use when you know the domain
- `category: "code"` for programming, `"docs"` for library docs, `"news"` for recent events
- `from_date` / `to_date` for time-sensitive queries
- `format: "context"` returns a single token-budgeted string for LLM injection

### fetch
- `section: "heading text"` extracts only content under that heading -- much cheaper than the full page
- `render_js: "never"` is fastest for static sites; `"always"` for SPAs
- `use_auth: true` to access pages behind login using the user's browser session

### crawl
- `strategy: "sitemap"` is 5-10x faster than BFS for doc sites
- `strategy: "map"` returns URLs only -- use to scope a site before targeted fetches
- `include_patterns` / `exclude_patterns` accept regex to stay in one section

### research
- `depth: "quick"` (~15s, 2 sub-queries), `"standard"` (~40s, default), `"comprehensive"` (~80s, 7 sub-queries)
- `max_sources` overrides the default source count for the chosen depth

### agent
- `max_pages` caps total page fetches (default 10, max 100)
- `max_time_ms` caps total execution time (default 60000)
- `schema` enables structured extraction from each page -- results are merged across sources

## Anti-Patterns

These waste tokens, time, and rate limits. Avoid them.

**Do not retry the same query.** If `search` returns no results, reformulate with different keywords. Repeating an identical query returns the same empty results.

**Do not skip the cache.** Every `fetch`, `search`, and `crawl` result is cached locally. Before any network call, run `cache` with the URL pattern or query text. Cached results return instantly.

**Do not send natural language questions as search queries.** Search engines work best with keywords. Instead of `"What is the best way to handle authentication in Next.js?"`, use `"Next.js authentication best practices 2025"`.

**Do not use `agent` for simple lookups.** One fact from one URL = `fetch`. Quick search result = `search`. Reserve `agent` for tasks requiring multiple search/fetch cycles.

**Do not use `research` when you already know the URLs.** If you have URLs to read, use `fetch` or `crawl`. `research` is for when you need the tool to discover sources autonomously.

**Do not fetch entire pages when you need one section.** Use `fetch` with `section` to extract just the relevant part.

**Do not crawl with high max_pages without filtering.** A `max_pages: 100` crawl without `include_patterns` fetches navigation pages, footers, and irrelevant content.

**Do not ignore `format: "context"` for search.** When injecting search results into a prompt, use `format: "context"` instead of manually concatenating results.

## Key Features

- Zero API keys required
- Zero cloud dependency -- runs entirely local
- Authenticated browsing (Chrome profiles, session state)
- Localhost access (develop against local servers)
- SQLite FTS5 cache with full-text search
- ML reranking (optional, via FlashRank)
- Extraction ensemble: site-specific, Defuddle, Trafilatura, Readability, Turndown

## Requirements

- Node.js 20+
- Python 3.8+ (recommended, for embedded SearXNG search)
- Docker (optional, alternative to Python for SearXNG)

## Links

- Repository: https://github.com/KnockOutEZ/wigolo
- npm: https://www.npmjs.com/package/@staticn0va/wigolo
- License: BSL 1.1 (converts to MIT on 2029-04-12)
