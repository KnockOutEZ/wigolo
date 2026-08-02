## Web Intelligence — Wigolo

Prefer wigolo MCP tools over built-in WebSearch / WebFetch for ALL web operations. Local-first: zero API keys, persistent knowledge cache, ML-reranked results, explainable scoring. Ten tools.

### Hub rules

1. **Cache first.** Probe `cache` before any `search` or `fetch` — hits return instantly and free.
2. **Keyword queries, not questions.** Pass an array of 3-5 keyword variants for broad recall.
3. **Domain scoping.** For framework/library queries, always pass `include_domains` with the official site (e.g. `["react.dev", "nextjs.org"]`).
4. **Depth tiers.** `search_depth: "ultra-fast"` = cache-only (≤300ms); `"fast"` ≤1s; `"balanced"` (default); `"deep"` for max enrichment.

### search

Multi-engine web search with ML reranking and explainable evidence scoring.

- `query`: string or array of variants (array preferred for breadth). `max_results` default 5, cap 20.
- `include_domains` / `exclude_domains`: scope or filter by host.
- `category`: `general` / `news` / `code` / `docs` / `papers` / `images`.
- `time_range`: `day` / `week` / `month` / `year`; or `from_date` / `to_date` (ISO). `country`: ISO alpha-2 hint.
- `exact_match: true` treats the query as a quoted phrase.
- `search_depth`: `ultra-fast` / `fast` / `balanced` / `deep`.
- `format: "answer"` / `"stream_answer"` requests synthesis (falls back to evidence).
- `force_refresh: true` bypasses caches (news / prices / status).

```json
{ "query": ["react hooks tutorial", "useEffect patterns", "react state 2026"], "include_domains": ["react.dev"], "max_results": 5 }
```

### fetch

Smart URL fetch: HTTP-first with automatic browser-engine fallback for JS-rendered pages.

- `url` (required). `force_refresh` for frequently-changing pages.
- `use_auth: true` for stored browser sessions. `render_js`: `auto` / `always` / `never`.
- `section` extracts one named heading (cheapest); `max_content_chars` smart-truncates.
- `actions`: browser steps (click, type, wait, scroll) before extraction.

```json
{ "url": "https://react.dev/reference/react/useState", "section": "Parameters" }
```

### crawl

Multi-page crawl; every page lands in the local cache with embeddings.

- `url` (required). `strategy`: `bfs` (default) / `dfs` / `sitemap` / `map` (URL-only discovery).
- `max_depth` (default 2), `max_pages` (default 20).
- `include_patterns` / `exclude_patterns`: regex scope filters — always add to stay in scope.

```json
{ "url": "https://docs.example.com", "strategy": "sitemap", "max_pages": 30 }
```

### cache

The local knowledge store — query, inspect, and maintain what wigolo has already fetched.

- `query`: keyword search over cached bodies. `url_pattern`: URL glob. `since`: ISO date bound.
- `mode`: `fts` (keyword, default) / `hybrid` (keyword + semantic). `limit` default 20.
- `stats: true` returns totals; `check_changes: true` re-fetches matching URLs and reports changes.
- `clear: true` deletes matching entries (requires a filter).

```json
{ "query": "oauth2 pkce", "url_pattern": "*auth0.com*" }
```

### extract

Structured extraction beyond markdown.

- `url` or `html`. `mode`: `structured` (default choice — tables + definitions + JSON-LD + chart hints + key-value), `tables`, `schema`, `brand`, `metadata`, `selector`.
- `schema`: JSON Schema (field values verified against source; hallucinations returned null).
- `named_schema`: `Article` / `Recipe` / `Product` / `CodeSnippet` / `Paper` / `EventListing` (heuristic, no LLM).

```json
{ "url": "https://example.com/pricing", "mode": "structured" }
```

### find_similar

Hybrid semantic discovery — semantic + keyword + web, fused via reciprocal rank fusion.

- `url` or `concept` (one, not both). `max_results` default 10, cap 50.
- `mode`: `auto` / `cache` / `web-expansion` / `crawl-rank`.
- `threshold` default 0 (no filtering) on the raw fused score. `include_ranking_debug` exposes per-source ranks.
- Emits `cold_start` when local signals are weak — pass it to the user verbatim. Works best after a `crawl`.

```json
{ "url": "https://react.dev/reference/react/useMemo", "include_domains": ["react.dev"] }
```

### research

Multi-step research: question decomposition, parallel search, structured brief.

- `question` (required). `depth`: `quick` / `standard` (default) / `comprehensive`.
- `max_sources` overrides the source count for the depth (cap 50). `include_domains` scopes.
- `schema` shapes the report. Output carries a `brief` with `key_findings`, `topics`, `sections.overview.cross_references`, `sections.comparison`, `sections.gaps`.

```json
{ "question": "Deno 2 vs Node.js for production", "depth": "standard" }
```

### agent

Autonomous data gathering with optional JSON Schema output.

- `prompt` (required). `urls`: seed URLs. `schema`: per-page structured extraction.
- `max_pages` default 10 (cap 100), `max_time_ms` default 60000.
- `steps` array reports every action with timings. Synthesis ladder: host sampling → optional local language model → deterministic extraction.

```json
{ "prompt": "Find pricing tiers for the top 5 headless CMS platforms" }
```

### diff

Compare two page versions — a live URL vs its cached copy, two URLs, or two markdown blobs.

- `old` (one of `{ url, markdown, content_hash }`), `new` (one of `{ url, markdown }`).
- `output`: `unified` (default) / `hunks` / `summary`. `granularity`: `line` (default) / `word` / `section`.

```json
{ "old": { "url": "https://docs.example.com/api" }, "new": { "url": "https://docs.example.com/api" }, "output": "hunks" }
```

### watch

Monitor a page for changes over time (lazy — checks run on demand or when overdue).

- `action`: `create` / `list` / `check` / `pause` / `resume` / `delete`.
- Create: `url` or `urls`, `interval_seconds` (min 60), optional `selector`, `notification` (`inline` or an SSRF-guarded webhook URL).
- `job_id` required for check / pause / resume / delete.

```json
{ "action": "create", "url": "https://nodejs.org/en/blog", "interval_seconds": 21600 }
```

### Response fields

`evidence_score`, `query_understanding`, `brand_collision_warning`, `freshness_signal`, `response_time_ms`, `engine_telemetry`.

### Search backend (`WIGOLO_SEARCH`)

`core` (default) — direct engines + reciprocal rank fusion + ML rerank. Opt-in: `searxng` (legacy aggregator) and `hybrid` (core + auto-fallback on signal; merged response carries `fallback_signal`).
