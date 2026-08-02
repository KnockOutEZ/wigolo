---
description: Quick reference for wigolo web intelligence tools (search, fetch, crawl, cache, extract, find_similar, research, agent).
---

# wigolo

Quick reference for wigolo web intelligence tools. Wigolo provides 10 MCP tools for local-first web access.

## Tool Selection

| Need | Tool | Key params |
|------|------|------------|
| Search | `search` | `query` (array!), `include_domains`, `category`, `time_range`, `exact_match`, `search_depth`, `format: "answer"` |
| Fetch page | `fetch` | `url`, `section`, `force_refresh` |
| Crawl site | `crawl` | `url`, `strategy: "sitemap"`, `max_pages`, `include_patterns` |
| Check cache | `cache` | `query`, `url_pattern`, `stats` |
| Extract data | `extract` | `url`, `mode: "structured"` |
| Find similar | `find_similar` | `url` or `concept`, `include_domains` |
| Deep research | `research` | `question`, `depth`, `include_domains` |
| Gather data | `agent` | `prompt`, `schema`, `max_pages` |
| Compare versions | `diff` | `old`, `new`, `output`, `granularity` |
| Watch for changes | `watch` | `action`, `url`, `interval_seconds`, `notification` |

## Common Patterns

```json
// Cache-first lookup
cache({ "query": "oauth2 pkce", "url_pattern": "*auth0.com*" })
// → if empty, fall through to search

// Multi-query search (breadth) with direct-answer synthesis
search({ "query": ["react hooks 2026", "useEffect patterns", "react state management"], "format": "answer" })

// Sub-second cache-only search
search({ "query": "react hooks", "search_depth": "ultra-fast" })

// Phrase-exact error lookup
search({ "query": "Cannot read properties of undefined", "exact_match": true, "category": "code" })

// Targeted doc fetch
fetch({ "url": "https://react.dev/reference/react/useState", "section": "Parameters" })

// Site indexing
crawl({ "url": "https://docs.example.com", "strategy": "sitemap", "max_pages": 30 })

// Structured extraction
extract({ "url": "https://example.com/pricing", "mode": "structured" })
```

## Docs

Full docs in `~/.claude/skills/wigolo/SKILL.md` and per-tool skills.
