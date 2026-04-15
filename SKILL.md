---
name: wigolo
description: Local-first web access MCP server for AI coding agents. Eight tools for search, fetch, crawl, cache, extract, find similar, research, and agent-driven data gathering. No API keys. Results cached in local SQLite.
author: KnockOutEZ
license: BUSL-1.1
repository: https://github.com/KnockOutEZ/wigolo
transport: stdio
install: npx @staticn0va/wigolo
runtime: node
min_runtime_version: "20"
tools:
  - name: fetch
    description: Fetch one URL, return clean markdown. Auto-routes between HTTP and Playwright. Supports sections, auth, screenshots, browser actions.
  - name: search
    description: Search the web, return extracted markdown per result. Single query or array of query variants. Domain, category, date filters. Optional synthesized answer via MCP sampling.
  - name: crawl
    description: Crawl a site from a seed URL. BFS, DFS, sitemap, or map (URL-only) strategies with regex include/exclude filters.
  - name: cache
    description: FTS5 search over previously fetched content. URL glob, date filters, stats, clear, and change detection via re-fetch.
  - name: extract
    description: Structured extraction from URL or raw HTML. Modes: selector (CSS), tables, metadata (meta + JSON-LD), schema (heuristic field matching).
  - name: find_similar
    description: Find pages similar to a URL or concept. Hybrid cache (FTS5 + embeddings) + optional web supplement.
  - name: research
    description: Multi-step research pipeline. Question decomposition, parallel sub-search, source synthesis with citations. Quick, standard, or comprehensive depth.
  - name: agent
    description: Natural-language data gathering. Plans searches/URLs, fetches in parallel within page and time budgets, optionally applies a JSON Schema to each page.
---

# wigolo

Local-first web search MCP server for AI coding agents. Ships eight tools over stdio. All network results land in a local SQLite cache.

## Quick Setup

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

**Warmup (recommended, one-time):**
```bash
npx @staticn0va/wigolo warmup          # installs Playwright Chromium + bootstraps SearXNG
npx @staticn0va/wigolo warmup --all    # also installs Firefox, WebKit, reranker, embeddings, trafilatura
npx @staticn0va/wigolo warmup --force  # wipe SearXNG state and rebuild
```

Warmup flags: `--force`, `--all`, `--trafilatura`, `--reranker`, `--firefox`, `--webkit`, `--embeddings`, `--lightpanda`.

## Tools

### fetch

Fetch a single URL and return clean markdown. Use when you already have a specific URL.

Parameters:
- `url` (string, required)
- `render_js`: `"auto"` (default) | `"always"` | `"never"`
- `use_auth`: boolean (default `false`) — reuses the user's browser session
- `max_chars`: number
- `section`: string — return only the content under a heading
- `section_index`: number (default `0`) — which heading match when multiple hit
- `screenshot`: boolean (default `false`)
- `headers`: object
- `force_refresh`: boolean — bypass cache
- `actions`: array of `{type, selector, text, ms, timeout, direction, amount}` — `click`, `type`, `wait`, `wait_for`, `scroll`, `screenshot`. Forces Playwright when present.

Example:
```json
{ "url": "https://react.dev/reference/react/useState", "section": "Parameters" }
```

Tip: `section` is much cheaper than reading the full page. Repeat fetches of the same URL are free from cache unless `force_refresh: true`.

### search

Search the web and return extracted markdown per result. Use when you don't have a URL yet.

Parameters:
- `query` (string OR `string[]`, required) — array runs variants in parallel and dedupes
- `max_results`: number (default `5`, cap `20`)
- `include_content`: boolean (default `true`)
- `content_max_chars`: number (default `30000`)
- `max_total_chars`: number (default `50000`)
- `time_range`: `"day"` | `"week"` | `"month"` | `"year"`
- `include_domains` / `exclude_domains`: `string[]`
- `from_date` / `to_date`: ISO `YYYY-MM-DD`
- `category`: `"general"` | `"news"` | `"code"` | `"docs"` | `"papers"` | `"images"`
- `language`: string
- `search_engines`: `string[]` — override engine selection
- `format`: `"full"` (default) | `"context"` (token-budgeted string) | `"answer"` (synthesized via MCP sampling) | `"stream_answer"` (answer + phase progress notifications)
- `force_refresh`: boolean

Example:
```json
{ "query": ["react server components patterns", "RSC data fetching", "react server components streaming"], "category": "docs", "include_domains": ["react.dev"], "max_results": 5 }
```

Tip: keyword queries beat natural-language questions. A 3–5 item `query` array usually finds more unique sources than one longer query.

### crawl

Crawl a site starting from a seed URL.

Parameters:
- `url` (string, required)
- `strategy`: `"bfs"` (default) | `"dfs"` | `"sitemap"` | `"map"` (URL-only discovery, no content)
- `max_depth`: number (default `2`)
- `max_pages`: number (default `20`)
- `include_patterns` / `exclude_patterns`: regex `string[]`
- `use_auth`: boolean (default `false`)
- `extract_links`: boolean (default `false`) — returns inter-page link graph
- `max_total_chars`: number (default `100000`)

Example:
```json
{ "url": "https://docs.python.org/3/library/", "strategy": "sitemap", "max_pages": 30, "include_patterns": ["^https://docs\\.python\\.org/3/library/asyncio"] }
```

Tip: `strategy: "sitemap"` is faster and more complete than BFS on doc sites. `strategy: "map"` returns URLs only — cheap way to scope before targeted fetches.

### cache

Search previously fetched content without hitting the network.

Parameters:
- `query`: FTS5 syntax — supports `AND`, `OR`, `NOT`, `"exact phrase"`
- `url_pattern`: glob (e.g. `"*react.dev*"`)
- `since`: ISO date
- `stats`: boolean — returns total URLs, size, date range
- `clear`: boolean — deletes matching entries (requires one of `query`, `url_pattern`, `since`)
- `check_changes`: boolean — re-fetches matching URLs, reports changed/unchanged with diff summaries

Example:
```json
{ "query": "useState OR useReducer", "url_pattern": "*react.dev*" }
```

Tip: cache hits are instant and cross-session. Run this before `search` or `fetch` when you suspect the content is already on disk.

### extract

Structured extraction from URL or raw HTML.

Parameters:
- `url` OR `html` (one required; `url` wins if both provided)
- `mode`: `"metadata"` (default) | `"selector"` | `"tables"` | `"schema"`
- `css_selector`: string — required for `mode: "selector"`
- `multiple`: boolean (default `false`) — return all matches, selector mode only
- `schema`: JSON Schema object with `properties` — required for `mode: "schema"`

Example:
```json
{ "url": "https://example.com/product", "mode": "schema", "schema": { "type": "object", "properties": { "price": { "type": "string" }, "name": { "type": "string" }, "sku": { "type": "string" } } } }
```

Tip: `mode: "schema"` does heuristic matching over CSS classes, ARIA labels, microdata, and JSON-LD — no LLM call required.

### find_similar

Find pages related to a URL or a free-text concept.

Parameters:
- `url` OR `concept` (one required)
- `max_results`: number (default `10`, cap `50`)
- `include_domains` / `exclude_domains`: `string[]`
- `include_cache`: boolean (default `true`)
- `include_web`: boolean (default `true`)

Example:
```json
{ "url": "https://react.dev/reference/react/useState", "max_results": 8, "include_domains": ["react.dev", "developer.mozilla.org"] }
```

Tip: uses hybrid 3-way search — FTS5 over titles, FTS5 over body, plus embeddings when available. Cache path is near-instant; web supplement runs only if cache yields too few results.

### research

Multi-step research pipeline with decomposition, parallel search, and cited synthesis.

Parameters:
- `question` (string, required)
- `depth`: `"quick"` (~15s, 2 sub-queries, 5–8 sources) | `"standard"` (~40s, default) | `"comprehensive"` (~80s, 7 sub-queries, 20–25 sources)
- `max_sources`: number (cap `50`) — overrides depth default
- `include_domains` / `exclude_domains`: `string[]`
- `schema`: JSON Schema — if present, report is structured to fill these fields
- `stream`: boolean — emit progress notifications per phase

Example:
```json
{ "question": "How do modern JS bundlers tree-shake ESM vs CJS?", "depth": "standard", "include_domains": ["webpack.js.org", "rollupjs.org", "esbuild.github.io", "vitejs.dev"] }
```

Tip: `research` checks cache internally — no need to pre-probe. Requires MCP sampling-capable client for synthesis; without sampling, returns raw sources in context format.

### agent

Natural-language data gathering. Plans queries and URLs from a prompt, runs them in parallel within budget, optionally applies a schema.

Parameters:
- `prompt` (string, required)
- `urls`: `string[]` — seed URLs to include
- `schema`: JSON Schema — extract structured fields per page and merge
- `max_pages`: number (default `10`, cap `100`)
- `max_time_ms`: number (default `60000`, cap `600000`)
- `stream`: boolean

Example:
```json
{ "prompt": "Compare pricing tiers for Supabase, Firebase, and Clerk", "schema": { "type": "object", "properties": { "provider": { "type": "string" }, "free_tier": { "type": "string" }, "paid_start": { "type": "string" } } }, "max_pages": 12 }
```

Tip: output includes a `steps` array showing every action (plan, search, fetch, extract, synthesize) with timings. Use this to debug why an agent run produced a weak result.

## Workflow Patterns

Quick routing:
- Use when `search` — you need information but don't have a URL.
- Use when `fetch` — you already have the URL.
- Use when `crawl` — you need multiple pages from one site.
- Use when `cache` — you want to check whether something is already on disk.
- Use when `extract` — you need specific fields, tables, or metadata, not the whole page.
- Use when `find_similar` — you have a good page/concept and want related content.
- Use when `research` — a question needs decomposition and multi-source synthesis.
- Use when `agent` — a natural-language task needs multi-step data gathering.

**Cache-first lookup.** Before any `fetch` or `search`, probe the cache.
```json
cache({ "query": "oauth2 pkce", "url_pattern": "*auth0.com*" })
// empty? fall through to search
search({ "query": "oauth2 pkce flow", "include_domains": ["auth0.com"] })
```

**Fresh content (news, dashboards, changelogs).** Bypass cache explicitly.
```json
search({ "query": "node.js 22 release notes", "force_refresh": true, "time_range": "week" })
fetch({ "url": "https://nodejs.org/en/blog", "force_refresh": true })
```

**Scoped documentation research.** Crawl the relevant slice, then query cache.
```json
crawl({ "url": "https://docs.astro.build", "strategy": "sitemap", "max_pages": 40 })
cache({ "query": "server islands hydration", "url_pattern": "*docs.astro.build*" })
```

**Broad exploration.** Pass a query array; dedup is automatic.
```json
search({ "query": ["rust async runtimes comparison", "tokio vs async-std vs smol", "rust executor benchmarks"], "max_results": 8 })
```

**More like this.** Start with a known-good URL, widen via `find_similar`.
```json
find_similar({ "url": "https://react.dev/reference/react/useMemo", "max_results": 6, "include_domains": ["react.dev"] })
```

**Complex synthesis.** One `research` call replaces 5+ manual search/fetch cycles.
```json
research({ "question": "Tradeoffs of vector DBs for RAG at 100M+ embeddings", "depth": "comprehensive" })
```

**Structured data from multiple sources.** Use `agent` with a schema.
```json
agent({ "prompt": "Find latency and pricing for top 5 edge compute providers", "schema": { "type": "object", "properties": { "provider": {"type":"string"}, "cold_start_ms": {"type":"string"}, "price_per_million": {"type":"string"} } } })
```

**Table extraction.** Skip markdown entirely.
```json
extract({ "url": "https://en.wikipedia.org/wiki/List_of_programming_languages", "mode": "tables" })
```

## Parameter Cheat Sheet

| Situation | Tool + parameters |
|---|---|
| Focused lookup, known site | `search` + `max_results: 3` + `include_domains` |
| Broad topic survey | `search` + `query: [...3-5 variants]` + `max_results: 8` |
| Fresh content required | any tool + `force_refresh: true` |
| Doc site indexing | `crawl` + `strategy: "sitemap"` |
| Site URL inventory only | `crawl` + `strategy: "map"` |
| Single heading from long page | `fetch` + `section: "..."` |
| Behind login | `fetch` / `crawl` + `use_auth: true` |
| Direct answer (sampling client) | `search` + `format: "answer"` |
| LLM-ready context blob | `search` + `format: "context"` |
| Complex question, multi-source | `research` + `depth: "standard"` |
| Structured multi-page extraction | `agent` + `schema` |
| One-page structured data | `extract` + `mode: "schema"` or `"tables"` |
| Change tracking | `cache` + `check_changes: true` |

## Anti-Patterns

**Do not skip the cache.** Running `search` or `fetch` without probing `cache` wastes time on content already on disk. `research` and `agent` check cache internally; manual `search`/`fetch` do not.

**Do not send natural-language questions to `search`.** Use keywords. `"how do I debounce in React hooks"` loses to `"react useDebounce hook custom"`.

**Do not retry an identical failing query.** Reformulate keywords, swap `category`, or add `include_domains`. Same query → same empty result.

**Do not use `agent` or `research` for one-URL lookups.** Use `fetch`. `agent` is for multi-source gathering; `research` is for decomposable questions.

**Do not crawl `max_pages: 100` without filters.** Always add `include_patterns` to stay in-scope. Unfiltered crawls fetch nav, footer, and sitemap garbage.

**Do not fetch whole pages when you need one section.** `fetch` + `section` reads under one heading only.

**Do not set `force_refresh: true` by default.** It defeats the cache. Use it for news, status, changelogs — content that actually churns.

**Do not pass a JSON Schema to `extract` without `properties`.** The handler rejects schemas that lack a `properties` key.

## CLI Commands

```bash
wigolo                  # default: start MCP server on stdio
wigolo mcp              # explicit: start MCP server
wigolo warmup [flags]   # install Playwright, bootstrap SearXNG, optional extras
wigolo serve            # start HTTP daemon on WIGOLO_DAEMON_PORT (default 3333)
wigolo health           # health probe, exits 0 if ok
wigolo doctor           # environment diagnostics (Python, Docker, Playwright, SearXNG)
wigolo auth discover    # list CDP sessions (needs WIGOLO_CDP_URL)
wigolo auth status      # show configured auth paths
wigolo plugin add <git-url>    # clone plugin into ~/.wigolo/plugins/
wigolo plugin list             # list installed plugins
wigolo plugin remove <name>    # remove a plugin
wigolo shell [--json]   # interactive REPL against subsystems
```

## Configuration

Top environment variables. All optional — defaults are safe.

| Variable | Default | Purpose |
|---|---|---|
| `WIGOLO_DATA_DIR` | `~/.wigolo` | Cache DB, SearXNG state, plugins, embeddings |
| `SEARXNG_URL` | unset | Point at an existing SearXNG (skips native bootstrap) |
| `SEARXNG_MODE` | `native` | `native` runs local Python SearXNG; `docker` runs container |
| `WIGOLO_CHROME_PROFILE_PATH` | unset | Chrome profile for `use_auth: true` |
| `WIGOLO_CDP_URL` | unset | Chrome DevTools endpoint (e.g. `http://localhost:9222`) |
| `MAX_BROWSERS` | `3` | Playwright pool size |
| `WIGOLO_BROWSER_TYPES` | `chromium` | Comma list: `chromium,firefox,webkit` |
| `WIGOLO_RERANKER` | `none` | `flashrank` for ML reranking |
| `WIGOLO_EMBEDDING_MODEL` | `BAAI/bge-small-en-v1.5` | Used by `find_similar` |
| `CACHE_TTL_CONTENT` | `604800` (7d) | Seconds before cached pages expire |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |

Full list: see `src/config.ts`.

## Links

- Repository: https://github.com/KnockOutEZ/wigolo
- npm: https://www.npmjs.com/package/@staticn0va/wigolo
- License: BUSL-1.1 (converts to AGPL-3.0 on 2029-04-12)
