# Changelog

## Unreleased — v1 prep

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
