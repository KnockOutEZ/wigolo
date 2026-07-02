<div align="center">

<img alt="wigolo — the go-to web for your agent" src="assets/brand/wigolo-banner.png" width="640">

Local-first web intelligence over MCP — **no keys, no cloud, no metered bill.**

[![npm](https://img.shields.io/npm/v/wigolo?color=cb3837&logo=npm)](https://www.npmjs.com/package/wigolo)
[![node](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-server-7c3aed)](https://modelcontextprotocol.io)
[![license](https://img.shields.io/badge/license-AGPL--3.0-2563eb)](#license)

[Quickstart](#quickstart) · [Tools](#the-tools) · [Why wigolo](#why-its-different) · [Benchmark](#benchmark) · [Architecture](#architecture) · [Configuration](#configuration) · [Contribute](#contributing)

</div>

---

wigolo runs on your machine as an MCP server and gives an AI coding agent one durable surface for everything web-related — **search, fetch, crawl, extract, cache, find-similar, research,** and autonomous gather loops. The core tools need no API keys, nothing it touches leaves `~/.wigolo/`, and there's no bill that grows with how much your agent thinks.

<div align="center">

<img alt="wigolo demo — Claude Code answering a live web question through wigolo, no API keys" src="assets/wigolo-demo.gif" width="800">

</div>

## Quickstart

Requires **Node ≥ 20** and ~1.5 GB of free disk. macOS, Linux, and Windows.

One command installs the local engine (search, browser, on-device models), wires it into your agent, and sets up the MCP connection:

```bash
npx wigolo init --non-interactive --agents=<your-agent>
```

- **`<your-agent>`** — one or more of `claude-code` · `cursor` · `codex` · `gemini-cli` · `vscode` · `windsurf` · `zed` · `antigravity` (comma-separated).

That's the whole setup — **search, fetch, crawl, extract, cache, and find-similar work with no API key.** Check it's healthy:

```bash
npx wigolo doctor
```

### Optional — enable answer synthesis

`research`, `agent`, and `search format=answer` use an LLM to *write* the final answer. Turn them on by setting a **provider and its key** (in your shell, or in your agent's MCP `env` block). `WIGOLO_LLM_PROVIDER` names the LLM — set it alongside the key:

```bash
export WIGOLO_LLM_PROVIDER=gemini
export GEMINI_API_KEY=<your-key>      # free from https://aistudio.google.com/apikey — the free tier is plenty
```

Any provider works — use `anthropic` + `ANTHROPIC_API_KEY`, `openai` + `OPENAI_API_KEY`, or `groq` + `GROQ_API_KEY`. To stay fully local and keyless, set `WIGOLO_LLM_PROVIDER=ollama` (or a local server URL) instead. Gemini is suggested because its free tier is more than enough for wigolo.

## The tools

| Tool | What it does |
|------|--------------|
| 🔎 `search` | Multi-engine web search (18 direct adapters) with rank fusion, ML cross-encoder reranking, and an explainable per-result score. Pass a query **array** for parallel breadth. |
| 📄 `fetch` | Load one URL through a tiered router (HTTP → TLS-impersonation → headless browser) that auto-escalates on anti-bot challenges or SPA shells. Clean markdown + metadata + links. |
| 🕸️ `crawl` | Multi-page crawl — BFS, DFS, sitemap, or map-only. Per-domain rate limits, robots.txt respect, boilerplate dedup. |
| 🧩 `extract` | Structured data from a page: tables, metadata, JSON-LD, brand identity, named schemas (Article / Recipe / Product / …), or any custom JSON Schema. |
| 💾 `cache` | Query everything already seen — keyword (BM25) or hybrid (BM25 + on-device vectors). Plus stats, clear, and change detection. |
| 🧲 `find_similar` | Pages similar to a URL or a concept, via 3-way fusion of keyword + semantic + live web. |
| 🧠 `research` | Decompose a question → fan out sub-queries → fetch sources → synthesize a cited report (or a structured brief the host LLM writes from). |
| 🤖 `agent` | Autonomous gather loop: plan → search → fetch → extract → synthesize, with a step log, time budget, and optional output schema. |

## Why it's different

- **$0 per query, free to re-query.** Default search talks to public engines through direct adapters; the reranker and embeddings run on-device. Every response is cached, so asking again is instant and costs nothing.
- **Private by default.** Cache, embeddings, models, and config live under `~/.wigolo/`. Nothing reaches a third party unless you explicitly opt into an LLM for synthesis.
- **Built for agents, not humans.** One MCP call fans out many queries across many engines in parallel — something a serial host tool-loop can't replicate — with transparent per-result scoring and budget-aware output.
- **Honest output.** Stale cache, failed fetches, degraded backends, and truncation are surfaced in the result, never disguised as empty-but-successful data.

wigolo is a focused web layer for one agent on one machine — not a hosted SaaS, a vector database other apps query, or a browser-automation framework. Within that lane it goes toe-to-toe with the paid services on result quality and wins outright on cost, privacy, and re-query speed — keyless, private, and $0 for every query your agent runs.

## Benchmark

One query, run live inside a single AI-agent session and fanned out to four web tools at once — built-in **WebSearch**, **wigolo**, **Tavily**, and **Firecrawl** — then scored by the agent itself. The prompt: `postgres 18 async IO real-world benchmark`.

wigolo matched the paid tools and pulled ahead. It surfaced the **same #1 source** as WebSearch (`postgresqlhtx.com`), returned as many results as Firecrawl, and was the **only** tool to hand back **real benchmark excerpts with an explainable per-result score** — pulling the concrete figure everyone else left on the table (`15,071ms → 5,723ms` on `io_uring`). Then it re-served the entire query **from local cache in ~3 ms, for $0** — no API key, nothing leaving the machine.

One honest query, not a cherry-picked leaderboard — run your own and you'll see the same shape: wigolo trading blows with the paid tools, then leaving them behind the moment you re-query. Here's the full run:

<div align="center">

<img alt="wigolo vs built-in WebSearch, Tavily, and Firecrawl on one real query" src="assets/wigolo-vs.gif" width="900">

</div>

## Architecture

A single Node process speaking MCP (JSON-RPC over stdio). Everything heavy is local and lazy-loaded, so a zero-key install pays nothing for the parts it isn't using.

```mermaid
flowchart TD
    A["🤖 AI coding agent<br/>any MCP client"]
    A -->|MCP over stdio| B["<b>wigolo</b><br/>8 tools · dynamic instructions<br/>in-process browser pool + cache + models"]

    B --> C{"Tool layer"}
    C --> T1["search · fetch · crawl · extract"]
    C --> T2["cache · find_similar · research · agent"]

    T1 --> F["⚙️ Fetch router<br/>HTTP → TLS-impersonation → headless browser<br/><i>per-domain learning</i>"]
    T1 --> S["⚙️ Search<br/>18 engines → RRF fusion → cross-encoder rerank<br/><i>explainable evidence score</i>"]
    T2 --> DB[("🗄️ SQLite<br/>url cache · FTS5 keyword · sqlite-vec")]
    T2 --> ML["🧠 On-device ML<br/>BGE-small embeddings (384d)<br/>MiniLM cross-encoder reranker"]

    F -.->|optional| LLM["☁️ Cloud LLM<br/>synthesis only · opt-in"]
    S -.->|optional| SX["🔀 Aggregator backend<br/>opt-in legacy / hybrid"]

    F --> WEB["🌍 Public web"]
    S --> WEB

    style B fill:#7c3aed,stroke:#5b21b6,color:#fff
    style WEB fill:#0ea5e9,stroke:#0369a1,color:#fff
    style DB fill:#1e293b,stroke:#334155,color:#fff
    style LLM stroke-dasharray: 5 5
    style SX stroke-dasharray: 5 5
```

- **Code beats model.** Deterministic work — canonicalization, rank fusion, dedup, schema matching, hashing — never touches an LLM. The model is reserved for judgment, opt-in, and capped per request. LLM-filled fields are checked against the source and nulled if absent, so hallucinations don't reach your output.
- **Routing on observable signals.** The fetch ladder escalates to a real browser on what it *sees* — SPA markers, challenge bodies, thin content — not domain guesses. It learns per-domain and unlearns when a site stops needing it.
- **Transparent, honest results.** Every result carries a score breakdown and a query-understanding block; degraded state is always surfaced, never hidden.

## Configuration

A clean install works out of the box. A few settings meaningfully raise output quality — set them as environment variables or in your agent's MCP `env` block.

```bash
# 1. Synthesis — the biggest lever. research / agent / search-answer need an LLM
#    to write the final text. Set the provider AND its key (a key alone is ignored).
export WIGOLO_LLM_PROVIDER=gemini                   # names the LLM; free tier is plenty (or anthropic/openai/groq)
export GEMINI_API_KEY=<your-key>                    # that provider's key (ANTHROPIC_API_KEY / OPENAI_API_KEY / …)
#   ...or fully local & keyless:  export WIGOLO_LLM_PROVIDER=ollama   (or a local http URL)

# 2. Wider retrieval funnel
export WIGOLO_SEARCH=hybrid                         # core engines + aggregator fallback
export WIGOLO_GITHUB_TOKEN=...                      # GitHub code search 10 → 30 req/min + org-private

# 3. Land more fetches, stay warm
export WIGOLO_TLS_TIER=auto                         # per-domain TLS-impersonation past Cloudflare/DataDome
export WIGOLO_EAGER_WARMUP=1                        # pay the ~1s model load up front, not on first search
```

For repeated interactive use, run `wigolo serve` so the browser pool, embeddings, and reranker stay resident across calls. To stay 100% on-device, a local LLM endpoint + `WIGOLO_TLS_TIER=auto` is the honest minimal set.

**Per-call habits that pay off:** query **arrays** (`["a","b","c"]`) for parallel breadth · `search_depth: "deep"` for queries that matter · `include_domains` as a hard filter for docs lookups.

<details>
<summary><b>CLI commands</b></summary>

| Command | What it does |
|---------|--------------|
| `wigolo` / `wigolo mcp` | Start the MCP stdio server (the default command). |
| `wigolo init` | Set up wigolo: install components, wire into detected agents. `--non-interactive --agents=<csv> --provider=<name> --search=<backend>` for CI. |
| `wigolo setup mcp` | Re-write just the MCP server entries, without the full wizard. |
| `wigolo doctor` | Cold-start health check — no network fetches. |
| `wigolo verify` | End-to-end smoke test (fetch, crawl, extract, search, rerank, embed). |
| `wigolo serve` | HTTP daemon — keeps subsystems warm across multiple clients. |
| `wigolo shell` | Interactive REPL (`--json` for piping). |
| `wigolo config` | Settings TUI; or headless `--set K=V`, `--export`, `--import`, `--cleanup`, `--uninstall --yes`. |
| `wigolo status` | Plain-text status summary. |
| `wigolo health` | Ping a running daemon's `/health`. |
| `wigolo backfill` | Embed cached pages that have no vector yet (`--batch-size`, `--dry-run`). |
| `wigolo plugin add\|list\|remove` | Manage custom extractor / search-engine plugins. |
| `wigolo uninstall` | Remove wigolo from agent configs (keeps your cache). |

</details>

<details>
<summary><b>Environment variables — search &amp; engines</b></summary>

| Var | Default | Effect |
|-----|---------|--------|
| `WIGOLO_SEARCH` | `core` | `core` (direct engines) / `searxng` (legacy) / `hybrid` (core + fallback). |
| `BRAVE_API_KEY` | — | When set, Brave joins the engine pool (env-only, never persisted). |
| `WIGOLO_GITHUB_TOKEN` | — | Lifts GitHub code search 10 → 30 req/min; enables org-private search (env-only). |
| `SEARXNG_URL` | — | External aggregator URL; when set, skips local bootstrap. |
| `SEARXNG_MODE` | `native` | `native` (Python venv) or `docker`. |
| `SEARXNG_PORT` | `8888` | Port for the native aggregator. |
| `SEARXNG_QUERY_TIMEOUT_MS` | `8000` | Per-query timeout to the aggregator. |
| `WIGOLO_MULTI_QUERY_CONCURRENCY` | `5` | Max parallel (query × engine) tasks. |
| `WIGOLO_MULTI_QUERY_MAX` | `10` | Max unique queries after normalization. |
| `WIGOLO_QUERY_EXPAND_VARIANTS` | `5` | Heuristic query-expansion variants. |

</details>

<details>
<summary><b>Environment variables — fetch, network &amp; TLS</b></summary>

| Var | Default | Effect |
|-----|---------|--------|
| `USER_AGENT` | rotating Chrome UAs | Override the User-Agent header. |
| `FETCH_TIMEOUT_MS` | `10000` | HTTP request timeout. |
| `FETCH_MAX_RETRIES` | `2` | Retry budget for 429 / 502 / 503 / network errors. |
| `MAX_REDIRECTS` | `5` | Manual-mode redirect cap. |
| `PLAYWRIGHT_LOAD_TIMEOUT_MS` | `15000` | Browser `page.load` wait. |
| `PLAYWRIGHT_NAV_TIMEOUT_MS` | `30000` | Browser navigation timeout. |
| `SEARCH_FETCH_TIMEOUT_MS` | `15000` | Per-result hydration fetch in search. |
| `SEARCH_TOTAL_TIMEOUT_MS` | `30000` | Aggregate search budget. |
| `USE_PROXY` / `PROXY_URL` | `false` / — | Route fetch through a proxy. |
| `WIGOLO_TLS_TIER` | `off` | `off` / `auto` (per-domain learned) / `on` (always try TLS first). |
| `WIGOLO_TLS_BROWSER` | `chrome_142` | TLS fingerprint profile (`<browser>_<version>`). |
| `WIGOLO_TLS_SUCCESS_THRESHOLD` | `3` | Successes before a domain flips to TLS-first. |

</details>

<details>
<summary><b>Environment variables — browser pool &amp; auth</b></summary>

| Var | Default | Effect |
|-----|---------|--------|
| `MAX_BROWSERS` | `3` | Max concurrent contexts per browser type. |
| `BROWSER_IDLE_TIMEOUT` | `60000` | Idle context eviction (ms). |
| `BROWSER_FALLBACK_THRESHOLD` | `3` | HTTP failures on a domain before forcing the browser. |
| `WIGOLO_BROWSER_TYPES` | auto (all 3) | CSV of browsers to use (chromium, firefox, webkit). |
| `WIGOLO_CDP_URL` | — | Chrome DevTools endpoint for a remote / logged-in browser. |
| `WIGOLO_AUTH_STATE_PATH` | — | Playwright `storageState.json` (cookies / localStorage). |
| `WIGOLO_CHROME_PROFILE_PATH` | — | Full Chrome `User Data` dir (copied to temp per use). |

</details>

<details>
<summary><b>Environment variables — cache &amp; crawl</b></summary>

| Var | Default | Effect |
|-----|---------|--------|
| `CACHE_TTL_SEARCH` | `86400` | Search result cache TTL (s). |
| `CACHE_TTL_CONTENT` | `604800` | Page content cache TTL (7 days). |
| `WIGOLO_FAST_STALE_MAX_HOURS` | `24` | In `cache` mode, accept entries up to this age. |
| `WIGOLO_FAST_TIMEOUT_MS` | `800` | Tight timeout for cache-mode fallback fetches. |
| `CRAWL_CONCURRENCY` | `2` | Per-public-domain concurrent fetches. |
| `CRAWL_DELAY_MS` | `500` | Per-public-domain inter-request delay. |
| `CRAWL_PRIVATE_CONCURRENCY` | `10` | Per-private-domain concurrency (localhost / RFC1918). |
| `CRAWL_PRIVATE_DELAY_MS` | `0` | Per-private-domain delay. |
| `RESPECT_ROBOTS_TXT` | `true` | When false, robots.txt is not fetched. |
| `VALIDATE_LINKS` | `true` | When false, broken-link probe is skipped. |
| `WIGOLO_CRAWL_INDEX` | — | `1` → crawled pages enqueued for embedding. |
| `WIGOLO_WAIT_FOR_INDEX` | — | `1` → embedding queue runs synchronously per page. |

</details>

<details>
<summary><b>Environment variables — reranker, embedding &amp; relevance</b></summary>

| Var | Default | Effect |
|-----|---------|--------|
| `WIGOLO_RERANKER` | `onnx` | `onnx` (cross-encoder) / `none` (consensus + authority + recency boosts only). |
| `WIGOLO_RERANKER_MODEL` | `Xenova/ms-marco-MiniLM-L-6-v2` | Cross-encoder model ID. |
| `WIGOLO_RERANKER_IDLE_TIMEOUT_MS` | `300000` | Hold the model warm 5 min after last use. |
| `WIGOLO_EMBEDDING_MODEL` | `BAAI/bge-small-en-v1.5` | Embedding model (384-dim). |
| `WIGOLO_EMBEDDING_IDLE_TIMEOUT` | `1800000` | Idle unload (30 min). |
| `WIGOLO_EMBEDDING_MAX_TEXT_LENGTH` | `8000` | Truncation before embedding. |
| `WIGOLO_RELEVANCE_THRESHOLD` | `0` | Min relevance for the agent's post-fetch filter. |
| `WIGOLO_FIND_SIMILAR_COLD_START_THRESHOLD` | `0.02` | Fused score below which `find_similar` emits `cold_start`. |

</details>

<details>
<summary><b>Environment variables — LLM integration (all optional)</b></summary>

| Var | Default | Effect |
|-----|---------|--------|
| `WIGOLO_LLM_PROVIDER` | — | `anthropic` / `openai` / `gemini` / `groq` / custom URL (Ollama, vLLM, LM Studio). |
| `WIGOLO_LLM_MODEL` | — | Universal model override. |
| `WIGOLO_LLM_MODEL_{ANTHROPIC\|OPENAI\|GEMINI\|GROQ}` | — | Per-provider model override (highest precedence). |
| `WIGOLO_LLM_MAX_CALLS_PER_REQUEST` | `1` | Hard ceiling on LLM calls per tool invocation. |
| `WIGOLO_LLM_CACHE_TTL_DAYS` | `7` | LLM response cache TTL. |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | — | Read on every call; never persisted. |
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | — | Gemini provider key (either name; read on every call, never persisted). |
| `GROQ_API_KEY` | — | Same. |
| `WIGOLO_LLM_API_KEY` | — | Generic key for whichever provider `WIGOLO_LLM_PROVIDER` names. The provider-specific var wins; ignored during auto-detect. |

Keys can also live in the OS keychain or an AES-encrypted file (`wigolo init` / `wigolo config`) — never in `config.json`.

</details>

<details>
<summary><b>Environment variables — daemon, warmup, paths, logging &amp; misc</b></summary>

| Var | Default | Effect |
|-----|---------|--------|
| `WIGOLO_DATA_DIR` | `~/.wigolo` | Root for cache, models, keys, plugins, aggregator venv. |
| `WIGOLO_CONFIG_PATH` | `${DATA_DIR}/config.json` | Persisted config path. |
| `WIGOLO_DAEMON_PORT` | `3333` | Listen port for `wigolo serve`. |
| `WIGOLO_DAEMON_HOST` | `127.0.0.1` | Bind address. |
| `WIGOLO_EAGER_WARMUP` | — | `1` → pre-warm embed + rerank on startup (fire-and-forget). |
| `WIGOLO_BOOTSTRAP_MAX_ATTEMPTS` | `3` | Aggregator bootstrap retry limit. |
| `WIGOLO_HEALTH_PROBE_INTERVAL_MS` | `30000` | Background backend-health probe period. |
| `WIGOLO_PLUGINS_DIR` | `${DATA_DIR}/plugins` | Plugin discovery root. |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error`. |
| `LOG_FORMAT` | `json` | `json` or human-friendly `text`. |
| `WIGOLO_TELEMETRY` | — | `1` → local NDJSON event log (off by default, no PII). |
| `WIGOLO_TELEMETRY_ENDPOINT` | — | Also POST events fire-and-forget to this URL. |
| `WIGOLO_TUI_REDUCED_MOTION` | — | `1` → disable TUI spinners / animations. |

</details>

<details>
<summary><b>Common per-call options (tool arguments)</b></summary>

| Option | Tools | Notes |
|--------|-------|-------|
| `mode` | fetch, search, crawl, extract, find_similar | `cache` (fast, stale-OK) / `default` (smart routing) / `stealth` (full browser, no cache). |
| `search_depth` | search | `ultra-fast` (cache only) / `fast` / `balanced` (default) / `deep` (evidence + rerank highlights). |
| `query` | search | `string` or `string[]` — arrays fan out in parallel. |
| `include_domains` / `exclude_domains` | search, find_similar, research | Hard whitelist / blacklist (host-suffix match). |
| `format` | search | `answer` / `stream_answer` — triggers LLM synthesis with citations. |
| `citation_format` | search, crawl, research, agent | `numbered` / `json` / `anthropic_tags`. |
| `time_range` / `from_date` / `to_date` | search | Recency bounds. |
| `render_js` | fetch | `auto` / `always` / `never`. |
| `use_auth` | fetch, crawl | Route through configured auth (CDP > Chrome profile > storage state). |
| `actions` | fetch | Sequential browser actions (`click`, `type`, `wait`, `wait_for`, `scroll`, `screenshot`). |
| `section` | fetch | Extract a markdown subtree at a heading. |
| `strategy` | crawl | `bfs` / `dfs` / `sitemap` / `auto` / `map`. |
| `mode` (extract) | extract | `selector` / `tables` / `metadata` / `schema` / `structured` / `brand`. |
| `named_schema` | extract | `Article` / `Recipe` / `Product` / `CodeSnippet` / `Paper` / `EventListing`. |
| `depth` | research | `quick` / `standard` / `comprehensive`. |
| `max_pages` / `max_time_ms` | agent | Per-invocation page cap (default 3) and wall-clock budget. |
| `max_tokens_out` | most | Aggregate output-token budget (default 4000). |
| `include_full_markdown` | fetch, crawl, research, agent | `false` → evidence excerpts instead of full bodies. |

</details>

## Contributing

Bug reports, feature requests, and PRs are all welcome — see **[CONTRIBUTING.md](CONTRIBUTING.md)**. Keep tool handlers thin (business logic lives in the domain modules), add tests, and run the suite before opening a PR. wigolo also has a plugin system for custom extractors and search engines: `wigolo plugin add <git-url>`.

## License

**[GNU AGPL-3.0-only](LICENSE).** Free to use, modify, and self-host — including inside a company. The one obligation: if you run a **modified** version as a network service, you must publish your modified source under the same license. That keeps wigolo open while preventing a closed, hosted fork. See **[SECURITY.md](SECURITY.md)** to report a vulnerability and **[TRADEMARK.md](TRADEMARK.md)** for use of the name. For commercial-licensing questions, reach out.

<div align="center">
<br>

wigolo is free and meant to stay that way — maintained, not paywalled.
If it saves you a metered search bill, a ⭐, a sharp issue, or a **[☕ coffee](https://buymeacoffee.com/knockoutez)** helps keep it sustainable.

<sub>Built and maintained by <a href="https://github.com/KnockOutEZ">@KnockOutEZ</a> · <a href="mailto:ktowhid20@gmail.com">ktowhid20@gmail.com</a></sub>

</div>
