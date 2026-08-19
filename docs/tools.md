# Tools

wigolo exposes ten tools. They're the same tools everywhere — MCP (stdio or HTTP), [REST](./rest-api.md), [SDKs](./sdks.md), and the [one-shot CLI](./cli.md) — with identical parameter names on the wire.

**Cache first.** Every fetched, crawled, or searched page lands in the local knowledge cache. The `cache` tool answers from disk instantly and free — check it before going to the network, and expect repeat questions in a session to get cheaper as the cache warms.

Common knobs shared by most tools: `max_tokens_out` (token-budget cap on total output, cl100k-base counting), `include_full_markdown` (multi-result tools return evidence excerpts by default; set `true` for full bodies), `citation_format` (`numbered` inline `[N]` markers, `json` for a `citations[]` array, or `anthropic_tags`), and `force_refresh` (skip all caches, go to the network).

---

## search

Multi-engine web search: query variants dispatched in parallel across direct engine adapters, fused with reciprocal-rank fusion, reranked by the on-device ML reranker, and enriched with extracted page content. Returns scored evidence with citations rather than bare links.

| Param | Type | Notes |
| --- | --- | --- |
| `query` | string \| string[] | Array form runs variants in parallel, dedupes, reranks together. |
| `max_results` | number | Default 5, max 20. |
| `max_fetches` | number | Cap content enrichment to the top N results. |
| `category` | enum | `general`, `news`, `code`, `docs`, `papers`, `images`. |
| `include_domains` / `exclude_domains` | string[] | Domain allow/deny lists. |
| `time_range` | enum | `day`/`week`/`month`/`year` — precision filter; undated pages pass through. |
| `from_date` / `to_date` | string | Strict ISO date bounds (pair with a date-aware category). |
| `exact_match` | boolean | Quoted-phrase semantics; non-matching results dropped. |
| `country` / `language` | string | Advisory geographic/language hints. |
| `search_depth` | enum | `ultra-fast` (cache-only, ≤300ms), `fast` (engines only, ≤1s), `balanced` (default, full pipeline), `deep` (max enrichment). |
| `mode` | enum | `cache`, `default`, `stealth` (full browser for JS-heavy result pages). |
| `format` | enum | `answer` / `stream_answer` request LLM synthesis (falls back to evidence when no LLM). |
| `agent_context` | object | `{ text, recent_urls, intent }` — ranks toward your task, drops already-seen URLs. |
| `include_favicon` / `include_images` | boolean | Per-result favicon URL / aggregated `images[]`. |

Notable response fields:

- `results[]` — `title`, `url`, `snippet`, `relevance_score`, and per-result:
  - `evidence_score` — explainable breakdown: `final` plus `components` (`base_rrf`, `context_cosine`, `domain_quality`, `lexical_alignment`, `recency_boost`, `engine_consensus`, `rare_terms`) and a one-line `explanation`.
  - `freshness_signal` — `published_date`, `inferred` flag, `confidence`.
- `evidence[]` + `citations[]` — quotable excerpts with `citation_id` and `source_span` (exact character range in the source), so an agent can cite verbatim.
- `query_understanding` — classifier view: `intent`, `entities`, `date_hint`, `language`, `is_brand_collision_prone`, considered `rewrites`, `compound_terms`.
- `engines_used`, `engine_telemetry[]` (`name`, `latency_ms`, `result_count`, `outcome`, `dedup_kept`), `engine_warnings`, `engine_pool` — degraded engines are reported, not hidden.
- `total_time_ms`, `response_time_ms`, `search_time_ms`, `fetch_time_ms`.
- On the `hybrid` backend, a merged response carries `fallback_signal` naming why the fallback fired.

```json
{ "query": ["rust async traits", "rust trait async fn stabilization"],
  "category": "docs", "include_domains": ["doc.rust-lang.org", "blog.rust-lang.org"],
  "max_results": 5 }
```

## fetch

Fetch one URL as clean markdown. Smart tiered routing: plain HTTP first, escalating to the browser engine on real signals (SPA shells, anti-bot challenges) rather than domain guesses. Handles JS-rendered pages, PDFs, and authenticated sessions.

Responses that are already text rather than a web page — a raw `.md` file, `robots.txt`, a JSON API — are returned exactly as the server sent them, based on the response content type rather than the URL suffix. Nothing is re-escaped or reflowed, so JSON stays parseable and markdown keeps its headings, lists and code fences. A JSON body carries no `links` or page metadata, because it has none.

Because the body is passed through untouched, a relative link inside it stays relative as written; the `links` array still reports those targets resolved to absolute URLs. Links and images written as raw HTML in a markdown file (badge blocks, for example) are reported alongside the ones in markdown syntax.

| Param | Type | Notes |
| --- | --- | --- |
| `url` | string | Required. |
| `render_js` | enum | `auto` (default), `always`, `never`. |
| `section` / `section_index` | string / number | Return only the section under a heading. |
| `max_content_chars` | number | Smart truncation at a paragraph boundary with a marker (preferred over `max_chars` hard slice). |
| `use_auth` | boolean | Use your stored browser session (see [configuration](./configuration.md#fetch-and-browser-engine)). |
| `actions` | array | Sequential browser actions before extraction: `click`, `type`, `wait`, `wait_for`, `scroll`, `screenshot`. Forces browser rendering. |
| `screenshot` | boolean | Capture a screenshot. |
| `headers` | object | Extra request headers. |
| `mode` | enum | `cache` (HTTP-only, stale ok), `default`, `stealth` (full browser render). |

Response: `markdown`, `title`, page metadata, cache status, and content-change info against the cached copy. A challenge that doesn't clear is labeled `blocked_by_challenge` — an honest failure, never junk content (see [troubleshooting](./troubleshooting.md#blocked_by_challenge)).

```json
{ "url": "https://nextjs.org/docs/app/building-your-application/caching",
  "section": "Data Cache", "max_content_chars": 4000 }
```

## crawl

Multi-page crawl into the local cache: BFS/DFS link-following, sitemap-driven, or `map` for URL discovery without content. Respects robots.txt by default, rate-limits per domain, dedupes anchor fragments, and revalidates with ETags. Crawled pages power later `cache` and `find_similar` calls.

| Param | Type | Notes |
| --- | --- | --- |
| `url` | string | Seed URL. Required. |
| `strategy` | enum | `bfs` (default behavior), `dfs`, `sitemap`, `map` (URLs only — fast). |
| `max_depth` | number | Default 2. |
| `max_pages` | number | Default 20. |
| `include_patterns` / `exclude_patterns` | string[] | URL regex allow/deny. |
| `extract_links` | boolean | Return the graph of links between pages. |
| `use_auth` | boolean | Crawl with your stored session. |

Response: `pages[]` with per-page markdown and metadata (`map` returns `urls[]` instead), totals, and skipped/error accounting. Budgets are sized for research-grade volumes — this is a docs-indexing tool, not a bulk harvester.

```json
{ "url": "https://docs.astro.build", "strategy": "sitemap",
  "include_patterns": ["/en/guides/"], "max_pages": 40 }
```

## cache

Query the persistent local knowledge cache — every page wigolo has already seen. Instant and free; check it before any network call.

| Param | Type | Notes |
| --- | --- | --- |
| `query` | string | Full-text search over cached content. |
| `mode` | enum | `fts` (default, keyword BM25) or `hybrid` (adds semantic vector search, fused by reciprocal-rank fusion). |
| `url_pattern` | string | Glob filter, e.g. `"*example.com*"`. |
| `since` | string | ISO date floor. |
| `stats` | boolean | Totals: URL count, size, date range. |
| `clear` | boolean | Delete matching entries, including the semantic-search vectors built from them (requires at least one filter). |
| `check_changes` | boolean | Re-fetch matching URLs and report changed/unchanged with diff summaries. Capped at `limit` entries (default 100, hard ceiling 200). |
| `url` | string | The page to read history for. Required by `at` and `versions`. |
| `at` | string | Point-in-time read: the body `url` served at or before this moment. |
| `versions` | boolean | List what is retained for `url`, newest first, without page bodies. |
| `limit` | number | Maximum rows returned. Default 5 (100 for `check_changes`, clamped to a ceiling of 200; 20 for `versions`, clamped to a ceiling of 200). |
| `max_tokens_out` | number | Token-budget cap on the returned page bodies. Default 16000. |

`limit` caps rows and is applied first; `max_tokens_out` then caps the total bytes of whatever rows survived. Both have defaults, so a cache check has a bounded cost even against a large cache.

When the budget trims the response it says so rather than returning a quietly shortened body: each affected row carries `truncated` (`"partial"` or `"omitted"`), and the response carries a `truncation` object with `original_chars`, `returned_chars`, `dropped_chars`, the per-row counts, and a hint. Raise `max_tokens_out`, narrow with `query` / `url_pattern` / `limit`, or `fetch` a specific URL for the full body.

Trimmed bodies end on a markdown boundary and carry a visible truncation marker. A construct left half-open by the cut — a link, an emphasis span, a table row — is dropped rather than shipped broken; a page that is one long code block keeps the code that fits with the block closed around it, instead of losing its whole body to that rule.

`check_changes` re-fetches every entry it reports on, so its row cap bounds live network requests as well as output. `limit` raises the count up to a hard ceiling of 200 — a scoped `url_pattern` points every one of those requests at the same host, so the ceiling is there to keep a single call from turning into a burst against one site. A `limit` above the ceiling is reduced rather than silently honoured.

When more entries matched than were checked, the response carries `changes_truncation` with `matched`, `checked`, a hint, and `limit_clamped_from` when the ceiling was what reduced the work. To continue past it, narrow the filter with `query` / `url_pattern` / `since` and call again.

### Reading a page's history

`url` + `at` returns the body that page served at or before a moment, as `version` (with `observed_at`, `content_hash`, `markdown`). It returns the newest version at or before the timestamp — **never a later one, and never the current page**. When nothing that old is retained you get `version_not_retained` instead of a body, so a past-time question is never answered with the present.

`at` accepts an ISO 8601 instant (`2026-08-18T12:00:00Z`), a value with a UTC offset, `YYYY-MM-DD`, or an offset-less `2026-08-18T12:00:00` / `2026-08-18 12:00:00` — an offset-less value is read as **UTC**, not as the host's local zone. Other formats are refused with an error rather than guessed at, because guessing means silently answering about the wrong instant.

`url` + `versions: true` lists what is retained, newest first, with no page bodies. Each entry's `content_hash` works as `diff`'s `old.content_hash`.

**What history does not promise.** Retention is bounded and sweeps **oldest-first across every URL**, so a busy site's churn can evict a quiet page's only retained version. A gap between entries is not evidence the page held still, and a version listed today may be gone later — every `versions` response carries a `note` saying so. A body that returns to a form it served before is re-timed onto its existing entry rather than added, so the entry count is a count of distinct retained bodies, **not a count of changes**.

`at` and `versions` read the past, so they cannot be combined with `check_changes`, `stats` or `clear`, which act on the present — the combination is refused rather than served with the time argument silently dropped.

```json
{ "query": "connection pool exhaustion", "mode": "hybrid", "limit": 10 }
```

## extract

Structured data out of any page (or raw HTML you pass in) — no LLM required for any mode.

| Mode | What you get |
| --- | --- |
| `structured` | Everything at once: tables, definition lists, key-value pairs, JSON-LD, microdata, chart hints. |
| `schema` | You provide a JSON Schema; field names are matched against the page via CSS classes, ARIA labels, microdata, and JSON-LD. With an LLM configured, LLM-sourced fields are verified against the source — hallucinated values come back as `null`, never invented. |
| `tables` | All tables as structured rows. |
| `metadata` | Title, description, OpenGraph/meta, canonical, dates. |
| `selector` | CSS-selector extraction (`css_selector` required; `multiple` for all matches). |
| `brand` | Logo, favicon, colors, fonts, social links — with provenance; favicons never promoted to `logo_url`. |

Also: `named_schema` (`Article`, `Recipe`, `Product`, `CodeSnippet`, `Paper`, `EventListing`) for strict heuristic-only extraction into a known shape, and `html` to extract from markup you already have.

```json
{ "url": "https://www.postgresql.org/support/versioning/", "mode": "tables" }
```

## find_similar

Hybrid semantic discovery: given a URL or a concept, fuses the local embedding index, keyword search, and live web search with 3-way reciprocal-rank fusion. Works best after a `crawl` has warmed the cache.

| Param | Type | Notes |
| --- | --- | --- |
| `url` or `concept` | string | Seed page, or a topic description when you have no URL. |
| `mode` | enum | `auto` (default), `cache`, `web-expansion`, `crawl-rank` (1-hop crawl from the seed, embed, cosine-rank). |
| `max_results` | number | Default 10, max 50. |
| `include_cache` / `include_web` | boolean | Toggle the two sides (both default true). |
| `threshold` | number | Hard post-filter on the raw `match_signals.fused_score` — an empty result is correct when nothing qualifies. |
| `include_ranking_debug` | boolean | Per-result `ranking_debug` (`fts5_rank`, `embedding_rank`, `web_rank`, `rrf_score`) to audit ranking disagreement. |

When local signals are weak the response carries a `cold_start` note telling you what to crawl first — surface it rather than treating thin results as final.

Cached pages whose capture produced only a shell — a challenge interstitial, or a page whose content never rendered — are left out of the local side of the ranking, so a page is never suggested as similar on the strength of boilerplate. Pages with no completeness verdict are unaffected.

```json
{ "url": "https://12factor.net/config", "max_results": 8 }
```

## research

Multi-step research: decomposes your question into sub-queries, searches them in parallel, validates and cross-references sources, and returns a structured brief. Works keyless; a configured LLM (including a local one via `WIGOLO_LOCAL_LLM=auto`) upgrades synthesis quality.

| Param | Type | Notes |
| --- | --- | --- |
| `question` | string | Required. |
| `depth` | enum | `quick` (~15s), `standard` (~40s, default), `comprehensive` (~80s). |
| `max_sources` | number | Override the depth default (max 50). |
| `include_domains` / `exclude_domains` | string[] | Scope the search space. |
| `schema` | object | Optional JSON Schema — structure the report around these fields. |
| `stream` | boolean | Progress notifications per phase (MCP transport only). |

The `brief` response object: `topics`, `highlights`, `key_findings` with index-aligned `key_finding_sources` (per-claim provenance), and `sections` — `overview.cross_references` (claims corroborated by multiple sources), `comparison` (when the question is comparative), and `gaps` (what the sources did not cover — read this before trusting completeness).

```json
{ "question": "How do Deno and Bun differ in Node.js compatibility?", "depth": "standard" }
```

## agent

Autonomous data gathering: plans queries and URLs from a natural-language prompt, executes fetches in parallel within a time budget, optionally extracts structured fields per page, and synthesizes. Every step is logged.

| Param | Type | Notes |
| --- | --- | --- |
| `prompt` | string | What to gather. Required. |
| `urls` | string[] | Seed URLs to include. |
| `schema` | object | JSON Schema — extract matching structured data from each page. |
| `max_pages` | number | Default 10, max 100. |
| `max_time_ms` | number | Default 60000. |
| `stream` | boolean | Per-step progress notifications (MCP transport only). |

Response: `result` (structured data in schema mode, synthesized text otherwise), `sources` (what was fetched, with per-source status), `steps` (the full plan/execute/synthesize log), and an explicit `warning` when the schema couldn't be honored or fetches failed — partial results are labeled, not disguised.

```json
{ "prompt": "Current LTS support windows for Node.js releases",
  "schema": { "type": "object", "properties": { "version": {"type":"string"}, "lts_until": {"type":"string"} } },
  "max_pages": 6 }
```

## diff

Compare two versions of content: a live URL against its cached copy (populate the cache with `fetch`/`crawl` first), two URLs, two markdown blobs, or a `content_hash` against anything.

**`content_hash` can reach a past body, within what is retained.** It resolves in two steps: the body some cached URL holds right now, and failing that, a retained earlier version of a page. So a hash handed out by an earlier `fetch` still works after that page changes — which is the ordinary case, since the cache keeps one row per URL and a re-fetch replaces it in place.

What it cannot do is promise the reach. Retained versions are bounded and swept oldest-first **across every URL**, so a version can be evicted by activity on unrelated pages, and a hash older than what survives matches nothing and the lookup fails explicitly rather than falling back to the page's current body. Use `cache` with `versions: true` to see what is actually retained for a page and to get the hashes that still resolve. For a version you must be able to reach indefinitely, hold onto its markdown (or export it — see [export](./export.md)) and pass that as `old.markdown`.

| Param | Type | Notes |
| --- | --- | --- |
| `old` | object | One of `{ url, markdown, content_hash }` — see the `content_hash` reach above. |
| `new` | object | One of `{ url, markdown }`. |
| `output` | enum | `unified` (git-style patch, default), `hunks` (structured per-section), `summary` (counts only: `added_lines`, `removed_lines`, `modified_lines`, `total_changed_chars`). |
| `granularity` | enum | `line` (default), `word` (token-level — tighter for intra-line edits), `section` (walks H1/H2/H3 boundaries). |

```json
{ "old": { "url": "https://nodejs.org/en/about/previous-releases" },
  "new": { "url": "https://nodejs.org/en/about/previous-releases" },
  "output": "summary" }
```

## watch

Register change-watch jobs on one or many URLs. Execution is lazy: jobs are checked while a `wigolo serve` daemon or an MCP session is active — a one-shot CLI call can register but not schedule.

| Param | Type | Notes |
| --- | --- | --- |
| `action` | enum | `create`, `list`, `check`, `pause`, `resume`, `delete`. Required. |
| `url` / `urls` | string / string[] | Single or batch create (mutually exclusive). |
| `interval_seconds` | number | Required on create; minimum 60. |
| `selector` | string | Scope the diff to a CSS-selected subtree. |
| `notification` | string | `inline` (default — reported on the next check) or a webhook URL. Webhook targets are SSRF-guarded: private and loopback addresses are refused. |
| `job_id` | string | Required for `check`/`pause`/`resume`/`delete`. |

```json
{ "action": "create", "url": "https://go.dev/doc/devel/release",
  "interval_seconds": 3600, "notification": "inline" }
```

[← Docs index](./README.md) · [Next: CLI](./cli.md)
