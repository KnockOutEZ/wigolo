# Wigolo

Local-first web search MCP server for AI coding agents. Fetches any URL and returns clean markdown with smart HTTP/Playwright routing, ensemble extraction, site-specific parsers, SQLite caching, and authenticated browsing.

## Setup

```bash
npm install
npx playwright install chromium
```

## Usage

Start the MCP server (stdio transport):

```bash
npx wigolo
```

Or in development:

```bash
npm run dev
```

Configure in your AI agent's MCP settings to connect via stdio.

## Testing

```bash
npm test            # full suite
npm run test:unit   # unit tests only
npm run test:e2e    # end-to-end tests
```

## Status

**Slice 1 (current):** `fetch` tool - fetches URLs, extracts markdown, caches results.

**Slice 2 (planned):** SearXNG-powered `search` tool, `crawl` tool, `cache` tool.
