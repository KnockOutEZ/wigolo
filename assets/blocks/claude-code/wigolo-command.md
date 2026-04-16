# wigolo

Quick reference for wigolo web intelligence tools. Wigolo provides 8 MCP tools for local-first web access.

## Tool Selection

| Need | Tool | Key params |
|------|------|------------|
| Search | `search` | `query` (array!), `include_domains`, `format: "highlights"` |
| Fetch page | `fetch` | `url`, `section`, `force_refresh` |
| Crawl site | `crawl` | `url`, `strategy: "sitemap"`, `max_pages`, `include_patterns` |
| Check cache | `cache` | `query`, `url_pattern`, `stats` |
| Extract data | `extract` | `url`, `mode: "structured"` |
| Find similar | `find_similar` | `url` or `concept`, `include_domains` |
| Deep research | `research` | `question`, `depth`, `include_domains` |
| Gather data | `agent` | `prompt`, `schema`, `max_pages` |

## Common Patterns

```json
// Cache-first lookup
cache({ "query": "oauth2 pkce", "url_pattern": "*auth0.com*" })
// → if empty, fall through to search

// Multi-query search (breadth)
search({ "query": ["react hooks 2026", "useEffect patterns", "react state management"], "format": "highlights" })

// Targeted doc fetch
fetch({ "url": "https://react.dev/reference/react/useState", "section": "Parameters" })

// Site indexing
crawl({ "url": "https://docs.example.com", "strategy": "sitemap", "max_pages": 30 })

// Structured extraction
extract({ "url": "https://example.com/pricing", "mode": "structured" })
```

## Docs

Full docs in `~/.claude/skills/wigolo/SKILL.md` and per-tool skills.
