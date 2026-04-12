# Wigolo

Local-first web search MCP server for AI coding agents. Zero API keys. Zero cloud dependencies. One command and it works.

Replaces Tavily, Brave Search API, Firecrawl, and Jina Reader with a single tool that fetches, searches, crawls, extracts, and caches — all on your machine.

## Quick Start

```bash
npx wigolo warmup    # one-time: downloads browser + search engine
```

### Claude Code

```bash
claude mcp add wigolo -- npx wigolo
```

### Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "wigolo": {
      "command": "npx",
      "args": ["wigolo"]
    }
  }
}
```

### Windsurf / Other MCP Clients

Run as stdio MCP server:

```bash
npx wigolo
```

## Tools

### `fetch`
Fetch a URL and return clean markdown. Smart HTTP/Playwright routing, ensemble extraction (Defuddle + Readability), section targeting, screenshot capture, authenticated browsing.

### `search`
Search the web via local SearXNG instance with fallback to direct scraping (Bing, DuckDuckGo, Startpage). Returns results with optional full content extraction. One call: query in, markdown out.

### `crawl`
Crawl a website from a seed URL. BFS, DFS, or sitemap strategies with depth/page limits, URL filtering, robots.txt compliance, and cross-page content deduplication.

### `cache`
Query the local knowledge base of previously fetched content. Full-text search (SQLite FTS5), URL pattern filtering, date filtering, cache statistics, selective clearing.

### `extract`
Extract structured data from web pages. CSS selector extraction, table-to-JSON conversion, metadata extraction (title, author, date, keywords, OpenGraph).

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SEARXNG_URL` | *(auto)* | External SearXNG URL (skips embedded instance) |
| `SEARXNG_MODE` | `native` | `native` (Python subprocess) or `docker` |
| `SEARXNG_PORT` | `8888` | Port for embedded SearXNG |
| `WIGOLO_DATA_DIR` | `~/.wigolo` | Data directory (cache DB, SearXNG, state) |
| `WIGOLO_AUTH_STATE_PATH` | *(none)* | Path to Playwright storage state JSON |
| `WIGOLO_CHROME_PROFILE_PATH` | *(none)* | Path to Chrome user profile directory |
| `MAX_BROWSERS` | `3` | Maximum concurrent Playwright browsers |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `LOG_FORMAT` | `json` | `json` or `text` |
| `FETCH_TIMEOUT_MS` | `10000` | HTTP fetch timeout |
| `CRAWL_CONCURRENCY` | `2` | Concurrent crawl requests |
| `CRAWL_DELAY_MS` | `500` | Delay between crawl requests |
| `VALIDATE_LINKS` | `true` | Validate search result links |
| `RESPECT_ROBOTS_TXT` | `true` | Honor robots.txt during crawling |

## Authenticated Browsing

### Storage State (recommended)

1. Export cookies from a logged-in browser session using Playwright:
   ```bash
   npx playwright codegen --save-storage=auth.json https://example.com
   ```
2. Set the environment variable:
   ```bash
   export WIGOLO_AUTH_STATE_PATH=./auth.json
   ```
3. Use `use_auth: true` in fetch/crawl tool calls.

### Chrome Profile

1. Find your Chrome profile path (e.g., `~/Library/Application Support/Google/Chrome/Default`)
2. Set the environment variable:
   ```bash
   export WIGOLO_CHROME_PROFILE_PATH="$HOME/Library/Application Support/Google/Chrome/Default"
   ```
3. Use `use_auth: true` in fetch/crawl tool calls.

**Note:** Close Chrome before using profile mode — Chrome locks its profile directory.

## Development

```bash
npm install
npm run dev          # start with tsx (hot reload)
npm test             # run full test suite
npm run test:unit    # unit tests only
npm run test:e2e     # end-to-end tests
npm run build        # compile TypeScript
```

## License

BSL 1.1 — see [LICENSE](LICENSE) for details. Converts to MIT after 3 years per version.
