<div align="center">

# wigolo

**Local-first web search MCP server for AI coding agents.**

Search, fetch, crawl, cache, and extract — zero API keys, zero cloud, zero cost.

[![License: BSL 1.1](https://img.shields.io/badge/License-BSL_1.1-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)](https://www.typescriptlang.org/)

[Quick Start](#quick-start) · [Features](#features) · [Why wigolo?](#why-wigolo) · [Roadmap](#roadmap)

</div>

```
$ claude mcp add wigolo -- npx @staticn0va/wigolo
Added MCP server wigolo

$ # That's it. Your agent now has web search.
```

## What is this?

wigolo gives AI coding agents (Claude Code, Cursor, Gemini CLI, Codex, Windsurf) web search, page fetching, site crawling, content extraction, and a local knowledge cache. It runs entirely on your machine. No API keys, no cloud, no cost — works out of the box with `npx`.

## Quick Start

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

**Optional warmup (improves quality on first use):**
```bash
npx @staticn0va/wigolo warmup          # Downloads Playwright + SearXNG
npx @staticn0va/wigolo warmup --all  # + ML reranking + Trafilatura extraction
npx @staticn0va/wigolo warmup --force     # Wipe SearXNG state/install/locks and re-bootstrap
```

## Diagnostics

Run `npx @staticn0va/wigolo doctor` to see the health of every component (Python, Docker, Playwright, Trafilatura, FlashRank, SearXNG install + process). Exits 0 when healthy, 1 when any required component is degraded. Usable in scripts: `npx @staticn0va/wigolo doctor && my-agent`.

## Daemon Mode

Run wigolo as a persistent HTTP server for lower latency and shared infrastructure:

### Start the daemon

```bash
npx @staticn0va/wigolo serve
npx @staticn0va/wigolo serve --port 4444 --host 0.0.0.0
```

The daemon exposes:
- `POST /mcp` -- StreamableHTTP MCP transport (preferred)
- `GET /sse` -- SSE MCP transport (legacy compatibility)
- `GET /health` -- Health check endpoint

### Check health

```bash
npx @staticn0va/wigolo health
# or
curl http://127.0.0.1:3333/health
```

Returns:
```json
{
  "status": "healthy",
  "searxng": "active",
  "browsers": "ready",
  "cache": "active",
  "uptime_seconds": 3600
}
```

### Auto-connect

When starting in stdio mode, wigolo checks if a daemon is already running on `WIGOLO_DAEMON_PORT`. If detected, a notice is printed to stderr. Full stdio-to-daemon proxy is planned for v2.1.

## Prerequisites

- **Node.js 20+** — [Download](https://nodejs.org/) or `brew install node` (macOS) / `winget install OpenJS.NodeJS` (Windows) / `sudo apt install nodejs` (Ubuntu/Debian)
- **Python 3.8+** *(recommended)* — [Download](https://python.org/) or `brew install python3` (macOS) / `winget install Python.Python.3` (Windows) / `sudo apt install python3` (Ubuntu/Debian)
- **Docker** *(optional)* — Alternative to Python for running SearXNG.

Everything else (Playwright, SearXNG) is downloaded automatically on first use or via `npx @staticn0va/wigolo warmup`.

### What works without Python?

Everything except embedded SearXNG. Without Python, search falls back to direct scraping of Bing, DuckDuckGo, and Startpage — functional but less reliable. All other tools (fetch, crawl, cache, extract) work fully with just Node.js.

## Features

### search

Search the web and get full markdown content in one call — not snippets.

```
search("React Server Components best practices", { max_results: 5 })
→ titles, URLs, relevance scores, and full extracted markdown per result
```

- Domain filtering: `include_domains: ["react.dev"]`, `exclude_domains: ["medium.com"]`
- Date filtering: `from_date: "2024-01-01"`, `to_date: "2025-01-01"`
- Category search: `general`, `news`, `code`, `docs`, `papers`
- ML reranking with FlashRank when installed
- Falls back to direct engine scraping when SearXNG is unavailable

### fetch

Fetch any URL and get clean markdown. The page-fetching engine behind `search`.

```
fetch("https://docs.react.dev/reference/react/useState")
→ clean markdown, links, images, metadata, cached for future use
```

- Smart routing: HTTP first, Playwright fallback for JS-rendered pages (auto-detected)
- Section targeting: `section: "Parameters"` extracts content under that heading
- Authenticated browsing: `use_auth: true` with stored session or Chrome profile
- PDF support: text extraction via pdf-parse

### crawl

Crawl a site from a seed URL — documentation sites, wikis, anything.

```
crawl("https://docs.example.com", { strategy: "sitemap", max_pages: 50 })
→ array of pages with titles, markdown, depth
```

- Strategies: `bfs`, `dfs`, `sitemap`, `map` (URL discovery only — no content, faster)
- URL filtering with include/exclude patterns (regex)
- robots.txt compliance
- Cross-page content deduplication (strips repeated nav/header/footer)
- Total character budget to prevent context overflow

### cache

Query previously fetched content without hitting the network.

```
cache({ query: "React hooks", url_pattern: "*react.dev*" })
→ matching cached pages with full markdown
```

- SQLite FTS5 full-text search over all cached content
- Combined filters: text query + URL pattern + date range
- Cache stats and selective clearing

### extract

Structured data extraction from any URL or HTML.

```
extract("https://example.com/product", { mode: "schema", schema: { price: "string", name: "string" } })
→ { price: "$29.99", name: "Widget Pro" }
```

Modes:
- `selector` — CSS selector → text content
- `tables` — HTML tables → structured row objects
- `metadata` — title, description, author, date, JSON-LD
- `schema` — JSON Schema → heuristic field matching from page content

## Why wigolo?

| | wigolo | Tavily | Firecrawl | Exa |
|---|---|---|---|---|
| Cost | Free | $30–500/mo | $16–500/mo | $7/1K queries |
| API key required | None | Yes | Yes | Yes |
| Authenticated browsing | Yes | No | No | No |
| Localhost access | Yes | No | No | No |
| Local cache + FTS | Yes | No | No | No |
| Search + extract unified | Yes | Yes | Partial | Partial |
| ML reranking | Local | Proprietary | No | Neural index |
| Rate limits | None | Tiered | Tiered | Tiered |

## Configuration

wigolo works with zero configuration. For advanced use:

```bash
# Use an existing SearXNG instance instead of the embedded one
SEARXNG_URL=http://localhost:8888

# Authenticated browsing — export session state via Playwright
WIGOLO_AUTH_STATE_PATH=~/.wigolo/auth.json

# Or use your Chrome profile directly (close Chrome first)
WIGOLO_CHROME_PROFILE_PATH=~/.config/google-chrome/Default

# ML reranking (install with: npx @staticn0va/wigolo warmup --reranker)
WIGOLO_RERANKER=flashrank

# Tune extraction — auto/always/never
WIGOLO_TRAFILATURA=auto

# Logging
LOG_LEVEL=info          # debug, info, warn, error
LOG_FORMAT=json         # json, text
```

Full list of env vars:

| Variable | Default | Description |
|---|---|---|
| `SEARXNG_URL` | *(auto)* | External SearXNG URL |
| `SEARXNG_MODE` | `native` | `native` or `docker` |
| `SEARXNG_PORT` | `8888` | Port for embedded SearXNG |
| `WIGOLO_DATA_DIR` | `~/.wigolo` | Data + cache directory |
| `WIGOLO_AUTH_STATE_PATH` | — | Playwright storage state JSON |
| `WIGOLO_CHROME_PROFILE_PATH` | — | Chrome user data directory |
| `WIGOLO_RERANKER` | `none` | `flashrank` or `none` |
| `WIGOLO_TRAFILATURA` | `auto` | `auto`, `always`, or `never` |
| `MAX_BROWSERS` | `3` | Concurrent Playwright contexts |
| `FETCH_TIMEOUT_MS` | `10000` | HTTP fetch timeout |
| `CRAWL_CONCURRENCY` | `2` | Concurrent crawl requests |
| `RESPECT_ROBOTS_TXT` | `true` | Honor robots.txt |
| `WIGOLO_BOOTSTRAP_MAX_ATTEMPTS` | `3` | Cap on SearXNG bootstrap auto-retries |
| `WIGOLO_BOOTSTRAP_BACKOFF_SECONDS` | `30,3600,86400` | Backoff seconds for retry attempts 1, 2, 3 |
| `WIGOLO_HEALTH_PROBE_INTERVAL_MS` | `30000` | Interval between SearXNG `/healthz` probes |
| `WIGOLO_DAEMON_PORT` | `3333` | HTTP server port for daemon mode |
| `WIGOLO_DAEMON_HOST` | `127.0.0.1` | HTTP server bind address for daemon mode |

## How it works

```
search query
    → SearXNG (70+ engines) or direct scraping (Bing/DDG/Startpage)
    → deduplicate by URL
    → domain/date/category filters
    → ML reranking (FlashRank, optional)
    → link validation
    → fetch + extract top N results in parallel
    → return markdown

Each step degrades gracefully:
  SearXNG down?        → direct scraping fallback
  Page needs JS?       → auto-detected, Playwright used transparently
  Extractor fails?     → ensemble: site-specific → Defuddle → Trafilatura → Readability → Turndown
  Already fetched?     → served from SQLite cache with FTS5
```

SearXNG bootstrap failures are self-healing: wigolo retries after 30 seconds, 1 hour, and 24 hours on successive server restarts. Once attempts are exhausted, direct-scraping stays permanent until the user runs `warmup --force`. Tool responses include a one-time fallback warning so agents can surface the recovery command. See `doctor` for the full state.

**Extraction ensemble** — every page runs through multiple extractors in order, falling back if content is below threshold:
1. Site-specific extractors (GitHub, Stack Overflow, MDN, docs frameworks)
2. Defuddle — markdown-aware, site-adaptive
3. Trafilatura — high-precision article extraction (Python, optional)
4. Readability.js — battle-tested Mozilla algorithm
5. Raw Turndown — last resort HTML-to-markdown

## Roadmap

### v2.1 — Next
- [x] Daemon mode — persistent HTTP server, zero startup latency
- [ ] Browser interaction — click, type, scroll before extraction
- [ ] Content change detection — diff monitoring for cached pages
- [ ] CDP session discovery — attach to running Chrome for seamless auth
- [ ] Plugin system — community extractors and search engines

### v2.2
- [ ] Multi-browser pool — Chromium + Firefox for fingerprint diversity
- [ ] Interactive REPL (`wigolo shell`)
- [ ] Agent skill distribution — MCP registry listings, `SKILL.md`

### v3 — The Knowledge Engine
- [ ] Answer synthesis — search + LLM = direct answers with citations (bring your own key)
- [ ] Semantic search — local vector embeddings over cached content (`findSimilar`)
- [ ] Agent endpoint — describe what you need, no URLs required
- [ ] Streaming answers — real-time generation as results come in
- [ ] Knowledge graph — entity and relationship extraction from crawled content
- [ ] Auto re-crawl scheduler — keep documentation fresh automatically
- [ ] Lightpanda browser — optional ultra-lightweight headless browser (11x less RAM than Chrome)
- [ ] Cloud sync — share cache across machines via rclone (S3, Drive, Dropbox)
- [ ] Team knowledge base — shared indexed content across team members

## Troubleshooting

**SearXNG won't start**
Make sure `python3` is on your PATH and version 3.8+. Check with `python3 --version`. Alternatively, set `SEARXNG_MODE=docker` if Docker is available.

**Playwright browser not found**
Run `npx @staticn0va/wigolo warmup` to download Chromium. This is done automatically on first use but can fail behind corporate proxies.

**Search returns no results**
If SearXNG and all fallback engines fail, check your network connection. Behind a proxy? Set `PROXY_URL=http://your-proxy:port`.

**Permission errors on `~/.wigolo/`**
wigolo stores its cache and SearXNG installation in `~/.wigolo/`. Ensure your user has write access. Override with `WIGOLO_DATA_DIR=/your/path`.

## Contributing

PRs welcome. Open an issue first to discuss what you'd like to change.

```bash
git clone https://github.com/KnockOutEZ/wigolo
cd wigolo
npm install
npm test
```

## Releasing

Releases are triggered by pushing a version tag. CI handles the rest.

```bash
# on main, all changes committed and pushed
make release-patch   # or: release-minor / release-major
```

Run `make help` for all targets, or `make release-dry-run` to preview the npm tarball.

The `release` workflow will:
1. Build a clean `dist/`
2. Verify the tag matches `package.json` version
3. Publish to npm with provenance
4. Create a GitHub Release with auto-generated notes

Requires the `NPM_TOKEN` repository secret (npm automation token with publish scope).

## License

[BSL 1.1](LICENSE) — free for individuals, small teams (under $1M revenue), education, and open source. Converts to MIT on 2029-04-12.
