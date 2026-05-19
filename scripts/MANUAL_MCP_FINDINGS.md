# Manual MCP Test Findings — 2026-05-19

Repro: `node scripts/manual_mcp_test.mjs` (writes `tmp/manual_mcp_runs/`).

Cold start, cache pre-populated (1416 URLs / 360 MB). 8 tools exercised over stdio MCP.

## Per-tool scoreboard

| Tool | Latency (cold) | Quality | Verdict |
|------|----------------|---------|---------|
| cache stats | 1.1 s init, 4 ms warm | clean JSON | ✅ |
| search single | 42 s | content + snippet OK | 🟡 slow |
| search multi (array) | 22 s | dedup + RRF OK | 🟡 slow |
| fetch static (Node docs) | 12 s | markdown clean, spurious `javascript` fences | 🟢 |
| fetch render (hono.dev) | 4.5 s | only 1.7 KB body, feature grid lost | 🟡 thin |
| extract structured (GitHub) | 1.3 s | tables found but commit-msg + date columns empty (JS-rendered) | 🔴 |
| crawl (sitemap → BFS fallback) | 6 s | **markdown="" on all crawled pages** | 🔴 |
| find_similar (concept, cache) | 61 s | Hono first hit, irrelevant tutorialspoint #2, markdown="" | 🔴 |
| research (quick) | 74 s (target ~15 s) | report body OK but 4/8 sources failed | 🟡 |
| agent | 9.6 s | **wrong domain: prompt was Hono, output was LINE.me content** | 🔴 |

Connect handshake = 11 s (embedding subprocess warmup).

## Critical defects to fix (priority order)

1. **agent planner ignores supplied `urls[]`.** Plan generated 5 unrelated searches (LINE, Roblox, chokubaijo, theroundup) for a Hono prompt with `urls=["https://hono.dev/docs"]`. Relevance filter excluded 3 but kept LINE @ score `0.000021`. Synthesis used it. Seed plan from supplied URLs + keyword-extract from prompt, not from generic search fallback. See `src/agent/`.

2. **Playwright headless-shell version mismatch.** Code requests `chromium_headless_shell-1217` but only `chromium_headless_shell-1200` + `chromium-1217` installed. Every SPA fetch fails (Instagram, Roblox in research/agent). Fix: `npx playwright install chromium-headless-shell` and add doctor check.

3. **Crawl returns empty markdown.** `total_found=3 crawled=3` but every `markdown: ""`. BFS fallback walker collects URLs but never wires content extraction. See `src/crawl/`.

4. **find_similar 61 s for cache-only search.** Embedding subprocess respawn (idle timeout 2 min in `src/embedding/`) + 8-result loop iterates cold. Keep subprocess alive while server alive in interactive MCP mode.

5. **DuckDuckGo `uddg=` redirect URLs leak through.** Sources like `//duckduckgo.com/l/?uddg=...` returned as-is in research/find_similar. Fetch then fails "Invalid URL". Unwrap in `src/search/dedup.ts` or fetch URL normalizer.

6. **GitHub structured extract weak.** Repo file table rows missing commit message + date (JS-hydrated cells). Site extractor for github.com should pull `<react-app>` JSON or hit `/api/repos/...`.

7. **Defuddle CSS crash on `:2` pseudo.** Spam stderr: `Unknown pseudo-class :2` from `css-select`. Probably mis-tokenized `:nth-child(2)`. Caught, doesn't break synthesis. Look at site that triggered (Instagram in this run).

8. **fetch on hono.dev returns 1.7 KB** (below `max_content_chars: 3000`). Defuddle giving up on Vue/Vite SPA. Hero card only, feature grid lost.

9. **search single 42 s cold.** ML rerank on snippets + content extraction of 5 results in serial. Split: rerank on snippets, lazy-fetch content for top-k only when `include_content=true`.

10. **fetch markdown contains bogus `javascript` fence lines.** `nodejs.org/api/fs.html` produced `\n\njavascript\n` between code blocks. Defuddle markdown converter mis-handles Node's docs `<pre>` tags.

## Things that work well

- Cache: 4 ms warm FTS, `url_pattern` glob works.
- Multi-query search dedup + RRF.
- Tool schema descriptions are clear; defaults (`include_full_markdown=false` on multi-result tools) match AI context budget reality.
- Research result shape: citations + source spans + highlights — exactly what an AI needs to attribute.

## Recency observations

- Cache age range 2026-05-01 → 2026-05-19, no auto-eviction visible.
- Multi-query surfaced a 2026-02-11 TS 5.5 article → good freshness.
- Static fetch returned Node v26.1.0 → current.
- No staleness markers exposed in result fields for the AI to reason about (`cached_at`, `age_days` would help).

## Artifacts

- Harness: `scripts/manual_mcp_test.mjs`
- Per-tool dumps: `tmp/manual_mcp_runs/01..12_*.txt` (gitignored, rerun harness to regenerate)
- Summary: `tmp/manual_mcp_runs/00_summary.json`
