# Changelog

## Unreleased

### License change (BREAKING for commercial users)

wigolo is now distributed under the [PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0), replacing the previous Business Source License 1.1 (root) and AGPL-3.0-or-later (`wigolo-ai-sdk` subpackage). The repository is now a single license everywhere.

- **Noncommercial users** (personal, research, education, hobby, charity, government): no action required. Continue using wigolo freely.
- **Commercial users** (any company, sole proprietorship, or organization using wigolo for the benefit of a commercial entity): you now require a separate commercial license or sponsorship arrangement. Contact <ktowhid20@gmail.com>.

The new license removes the previous BUSL change-date conversion to AGPL — there is no longer a scheduled open-source transition. The change is intentional: wigolo's commercial-rights model is now a single, plain-English license rather than a multi-layered time-bombed structure.

## v0.1.22 — 2026-05-27

A batch of correctness, latency, extraction, discovery, and search-breadth improvements. Additive; no breaking API changes — existing callers continue to work; new defaults are tighter where they were previously silently wrong.

### Trust & correctness
- **Silent failures surfaced** — fetch envelopes now carry `fetch_failed` reasons (`blocked`, `timeout`, `network`, `extractor`) instead of returning empty success shapes. Block-detection added for Reddit / Amazon paths.
- **Evidence cap honored** — multi-result tools respect the per-result evidence cap end-to-end; no more silent overflow.
- **Hard filters enforced** — `include_domains` / `exclude_domains` are now strictly applied at the orchestrator boundary, not best-effort at the ranker.
- **Schema truth** — extract `mode: 'schema'` is structurally prevented from hallucinating fields not present in the page; missing fields emit `null` with a `field_missing` reason, never a fabricated value.

### Latency & router
- Smart-router escalation tightened: avoid false-positive Playwright launches for pages whose initial HTTP body already contains the target content. Perceived-latency win on docs/blogs.

### Extractor cleanup
- Wikipedia chrome (navboxes, edit-links, citation-needed markers) filtered from main-content output.
- Crawl markdown is now populated for all crawled pages (previously empty on some BFS branches).
- PDF fetch wired via `pdf-parse` v2 — `.pdf` URLs return extracted text instead of binary garbage.
- Anchor-fragment dedup: `#section-1` and `#section-2` on the same page no longer count as separate results.

### Discovery honesty
- Reddit / Amazon block-detection: bot-walls return an explicit `fetch_failed: 'blocked'` envelope instead of a misleading partial.
- `find_similar` surfaces `cold_start: true` when the local cache lacks signal — tune `WIGOLO_FIND_SIMILAR_COLD_START_THRESHOLD`.
- New opt-in `include_ranking_debug` flag on search exposes per-result rank components for debugging.

### Long-tail polish
- 14 small fixes including: word-LCS guard (`DIFF_TOKEN_CAP` + `Uint32Array` for large diffs), `engines_used` semantics aligned with `engine_telemetry`, freshness omitted when undetectable, watch shape carries both `job` (single) and `jobs[]` (batch) for back-compat.

### Core engine breadth
- **Image search on core** — `category: 'images'` now works on the core backend via DDG Image + Brave Image adapters (the image vertical no longer requires the legacy aggregator).
- Mojeek and Marginalia added to the general vertical for long-tail diversity.
- Doctor command now prints a per-engine health-check summary on cold start.

### Adapter quality
- 14-engine review pass. Lobsters User-Agent fix. GitHub Code adapter now accepts a Bearer token via `WIGOLO_GITHUB_TOKEN` (anonymous rate-limit is 10/min — set the token for 30/min). Quality-tier metadata added per engine.

### Ranking quality
- Tier-based RRF weights derived from engine quality metadata (high-quality engines weighted higher in fusion).
- Cross-engine canonical URL dedup: `utm_*`, AMP variants, mobile subdomains, protocol differences, and trailing-slash variants now collapse to a single result.
- Static-synonym low-recall query expansion when initial pass returns too few results.

### Added — env vars
- `WIGOLO_GITHUB_TOKEN` — Bearer token for github-code adapter (optional, raises rate limit).
- `BRAVE_API_KEY` — required for Brave + Brave Image adapters.

### Added — new files (for inventory)
- `src/search/engines/{ddg-image,brave-image,mojeek,marginalia}.ts`
- `src/search/core/{engine-quality,engine-health,canonical-url,query-expansion}.ts`
- `src/extraction/{schema-truth,brand-provenance}.ts`
- `src/cache/migrations/006-url-cache-http-status.sql`

### API additions (back-compat)
- `category: 'images'` on `search` (core backend).
- `include_ranking_debug` flag on `search`.
- `engine_warnings.needs_key` with env-hints on `search`.
- `truncated: true` field on `extract` table output.
- `fetch_failed: 'blocked'` envelope on `fetch`.
- Watch tool single-vs-batch shape (`job` + `jobs[]`).
- `cold_start: true` on `find_similar` when signals are weak.

## [1.2.0] - unreleased

### Changed
- **reranker:** moved to Python subprocess (`tokenizers` + `onnxruntime`). Drops `@xenova/transformers`, `onnxruntime-node`, and the `protobufjs` `overrides` pin. Install via `wigolo warmup --reranker`. No user-visible API change. xenova-compat tokenizer patching matches the previous JS path on 4/6 corpus buckets; `4_emoji_zwj` and `2_ascii_long_truncating` are accepted-mismatch (xenova bugs that don't generalize cleanly to canonical SentencePiece).
- `WIGOLO_RERANKER=flashrank` now aliases to `onnx` with a warn log (was a throw).

### Added
- `WIGOLO_RERANKER_MAX_LENGTH` (default 512).
- `WIGOLO_RERANKER_READY_TIMEOUT_MS` (default 60000).
- `WIGOLO_RERANKER_REQUEST_TIMEOUT_MS` (default 30000).
- `WIGOLO_RERANKER_IDLE_TIMEOUT_MS` (default 300000).
- `WIGOLO_RERANKER_INHERIT_PYTHON_ENV` (default off — strips `PYTHONHOME/PYTHONPATH/PYTHONSTARTUP` from the subprocess by default).
- `wigolo doctor` reports `tokenizers`/`onnxruntime` versions and flags stale venvs.

### Removed
- `@xenova/transformers`, `onnxruntime-node`, `onnxruntime-web`, `onnx-proto` dependencies.
- `protobufjs` `overrides` pin.
- `src/search/reranker/tokenizer.ts`.

## v1.0.2 — 2026-05-01

### FIX: `fetch` markdown body now bounded by default
- Single-URL `fetch` previously returned the full markdown body unbounded when
  the caller didn't set `max_tokens_out`/`max_chars`. Large documentation pages
  could exceed the host's per-tool-result size cap and get truncated by the MCP
  client. New default cap is 16000 tokens (~64KB), well under typical 25k-token
  tool-result limits but generous enough for full doc pages. Override via
  `max_tokens_out` or `max_chars` for tighter or looser caps.

## v1.0.1 — 2026-05-01

### FIX: `fetch` returns full markdown by default
- Single-URL `fetch` now defaults `include_full_markdown: true`. Previous v1.0.0
  default of `false` produced empty `markdown` for callers that didn't opt in,
  matching multi-result tools where evidence-only is the right default. `fetch`
  is single-result and should return the body. Pass `include_full_markdown: false`
  to opt out and get evidence-only.
- Multi-result tools (`search`, `research`, `find_similar`, `crawl`, `agent`)
  unchanged — still default to evidence-only.

### FIX: `mode: 'fast'` skips evidence + link validation
- Fast mode now skips `applyEvidenceDefault` (passage extraction + ONNX
  passage-rerank) and `validateLinks` (HEAD-request gauntlet). Evidence
  extraction was warming the reranker model on every fast call, costing
  multiple seconds. Fast mode is now shape-only — raw engine results, no
  post-processing. Use `balanced` or `deep` to get evidence excerpts.

## v1.0.0 — 2026-05-01

### NEW: mode parameter on search and fetch
- `mode: 'fast' | 'balanced' | 'deep'` on both `search` and `fetch` tools.
  Default `balanced` (no behavior change vs. prior release).
- **fast** — HTTP-only fetch (never spawns a browser; sets `js_required: true`
  when the HTTP body looks like a JS shell), single search engine, reranker
  skipped, cache rows up to 24h past expiry are returned with `stale: true`
  and `cached_at`. Hard 800ms HTTP timeout (`WIGOLO_FAST_TIMEOUT_MS`).
- **balanced** — current behavior: full engine fan-out, reranker on, standard
  cache freshness.
- **deep** — single string queries auto-expand to 3–5 deterministic variants;
  reranker on; the top 5 results are fetched full-body via the smart router.
- New env vars: `WIGOLO_FAST_STALE_MAX_HOURS` (default 24),
  `WIGOLO_FAST_TIMEOUT_MS` (default 800).
- Output additions: `FetchOutput.cached_at`, `.stale`, `.js_required`;
  `SearchResultItem.cached`, `.cached_at`, `.stale`. Note: `cached` and
  `cached_at` are stamped on every cache-hit result (all modes), not just
  stale fast-mode rows — strict superset of the issue acceptance criteria.

### NEW: Markdown post-processor
- Code blocks now carry language tags (e.g. ` ```ts `, ` ```py `) when the
  source HTML exposes a hint via `language-*`, `lang-*`, `hljs-*`,
  `prism-language-*`, or `highlight-source-*` class attributes. Common
  aliases collapse to short forms (`typescript→ts`, `javascript→js`,
  `python→py`, `rust→rs`, `golang→go`, `shell→sh`).
- Boilerplate stripping runs both as a DOM pre-pass (cookie banners, share
  bars, "On this page" rails, feedback widgets, related/recommended modules,
  newsletter signups) and as a post-Turndown text pass for residual markers.
- Cross-page navigation lines that repeat across ≥60% of a crawl batch are
  removed from the leading 30 / trailing 20 lines per page (kicks in at
  4+ pages so small captures stay intact).
- Anchor-only and path+fragment links resolve correctly in extracted
  markdown — fragment-only `href="#section"` resolves to the page's
  canonical URL with the fragment retained; `/path#section` becomes an
  absolute URL with the fragment retained.

### NEW: BYO cloud LLM extract fallback (opt-in)
- When the deterministic extractor leaves required schema fields empty, an
  optional cloud LLM call fills them. Set any of `ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`, `GOOGLE_API_KEY`, or `GROQ_API_KEY` to enable; with no
  keys set, extract returns the partial result plus a warning listing each
  env var.
- Provider order: anthropic → openai → gemini → groq. Override with
  `WIGOLO_LLM_PROVIDER=<name>` (ignored when its key is missing).
- Default models: Claude Haiku 4.5, gpt-4o-mini, gemini-2.5-flash-lite,
  llama-3.3-70b-versatile.
- All calls cached in a new `llm_cache` SQLite table keyed by
  (model, prompt-hash, schema-hash). Default 7-day TTL — override via
  `WIGOLO_LLM_CACHE_TTL_DAYS`.
- Hard cap of 1 LLM call per `extract()` request; override via
  `WIGOLO_LLM_MAX_CALLS_PER_REQUEST`.
- Filled fields carry provenance `'llm'`. The orchestrator never overrides
  fields the deterministic extractor already populated.
- New `wigolo doctor` section reports configured providers and current
  budget/TTL settings.

### BREAKING: reranker rewritten to in-process ONNX
- The `WIGOLO_RERANKER=flashrank` value is retired and now throws on startup.
  Default is `onnx`. The Python `flashrank` package is no longer used and may
  be uninstalled.
- Migration: unset `WIGOLO_RERANKER` (the new default `onnx` is correct), or
  set `WIGOLO_RERANKER=onnx` explicitly. Run `wigolo warmup --reranker` to
  download the model on first run; it caches under `~/.wigolo/models/`.
- Default model: `BAAI/bge-reranker-v2-m3` (ONNX quantized) for accuracy. For
  low-RAM machines or a tighter latency budget: `WIGOLO_RERANKER_MODEL=minilm-l12`.
- Recency-aware scoring: queries containing recency tokens
  (`recent|latest|new|just released|today|this week`) or a year ≥ current year
  apply a date-boost factor (1.5× / 1.3× / 1.1× for <7d / <30d / <90d).
- Model assets are SHA-256 verified against a manifest; corrupt files are
  re-downloaded automatically.
- Removed: `src/search/flashrank.ts` and the Python `flashrank` subprocess
  code path.

### BREAKING: search.format renamed
- Removed: `format: 'full' | 'context' | 'highlights'`. Default output is now the evidence shape.
- Retained: `format: 'answer' | 'stream_answer'` (LLM-synthesis modes).
- Migration:
  ```diff
  - search({ query, format: 'highlights' })
  + search({ query })  // returns evidence by default
  - search({ query, format: 'full' })
  + search({ query, include_full_markdown: true })
  ```

### NEW: max_tokens_out
- Token-budget cap on total output. cl100k-base BPE; non-OpenAI counts may drift ~5-15%.
- When both `max_tokens_out` and `max_chars` are set, `max_tokens_out` wins.

### NEW: include_full_markdown
- Multi-result tools default to evidence-only (no full markdown body) — set `include_full_markdown: true` to restore.

### NEW: citation_format
- `'numbered'` (default) | `'json'` | `'anthropic_tags'`.
