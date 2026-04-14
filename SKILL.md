---
name: wigolo
description: Local-first web search MCP server for AI coding agents. Search, fetch, crawl, cache, and extract from the web with zero API keys, zero cloud, zero cost.
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
    description: Extract structured data from a web page. Supports CSS selector extraction, HTML table parsing, metadata extraction (title, author, JSON-LD), and JSON Schema heuristic matching.
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
{
  "query": "React Server Components best practices",
  "max_results": 5,
  "include_domains": ["react.dev", "vercel.com"],
  "from_date": "2024-01-01"
}
```

Returns: titles, URLs, relevance scores, and full extracted markdown per result.

### fetch

Fetch any URL and get clean markdown.

```json
{
  "url": "https://docs.react.dev/reference/react/useState",
  "section": "Parameters"
}
```

Returns: clean markdown, links, images, metadata. Cached for future use.

### crawl

Crawl a site from a seed URL.

```json
{
  "url": "https://docs.example.com",
  "strategy": "sitemap",
  "max_pages": 50
}
```

Returns: array of pages with titles, markdown, depth. Supports `bfs`, `dfs`, `sitemap`, `map` strategies.

### cache

Query previously fetched content without hitting the network.

```json
{
  "query": "React hooks",
  "url_pattern": "*react.dev*"
}
```

Returns: matching cached pages with full markdown and fetch timestamps.

### extract

Structured data extraction from any URL or HTML.

```json
{
  "url": "https://example.com/product",
  "mode": "schema",
  "schema": {
    "type": "object",
    "properties": {
      "price": { "type": "string" },
      "name": { "type": "string" }
    }
  }
}
```

Modes: `selector` (CSS), `tables` (HTML tables), `metadata` (meta tags + JSON-LD), `schema` (JSON Schema heuristic matching).

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
