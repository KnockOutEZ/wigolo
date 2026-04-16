---
name: wigolo-crawl
description: |
  Crawl an entire website or site section. Use when the user wants to index documentation, crawl a docs site, extract all pages under a path, or says "crawl", "index this site", "get all the docs", "bulk extract". Supports sitemap, BFS, DFS strategies with rate limiting and robots.txt respect.
---

# wigolo crawl

Crawl sites with configurable strategy, depth, and rate limiting.

## Quick Reference

```json
// Crawl docs via sitemap (fastest, recommended for doc sites)
{ "url": "https://docs.example.com", "strategy": "sitemap", "max_pages": 30 }

// BFS crawl with scope filter
{ "url": "https://example.com", "strategy": "bfs", "max_depth": 3, "max_pages": 50, "include_patterns": ["^https://example\\.com/docs"] }

// URL discovery only (no content fetched — fastest for scoping)
{ "url": "https://example.com", "strategy": "map" }

// Authenticated crawl
{ "url": "https://app.example.com/docs", "strategy": "bfs", "use_auth": true, "max_pages": 20 }
```

## Parameters

| Parameter | Type | Default | When to use |
|-----------|------|---------|-------------|
| `url` | string | required | Seed URL |
| `strategy` | string | "bfs" | "sitemap" for doc sites, "map" for URL discovery only |
| `max_depth` | number | 2 | How many link levels to follow |
| `max_pages` | number | 20 | Hard cap on pages fetched |
| `include_patterns` | string[] | none | Regex whitelist — ALWAYS add to stay in scope |
| `exclude_patterns` | string[] | none | Regex blacklist |
| `use_auth` | boolean | false | For authenticated sites |
| `extract_links` | boolean | false | Return inter-page link graph |
| `max_total_chars` | number | 100000 | Total char budget |

## After Crawling

All crawled pages enter the local cache with embeddings. This means:
- `cache({ query: "..." })` finds content instantly (no network)
- `find_similar({ url: "..." })` discovers related pages from cached content
- Future searches that hit cached URLs return instantly

**Crawl first, then use cache and find_similar for all subsequent lookups.**

## Anti-Patterns

- DON'T crawl `max_pages: 100` without `include_patterns` — fetches nav, footer, sitemap garbage
- DON'T use BFS on large doc sites — use `strategy: "sitemap"` (faster, more complete)
- DON'T crawl when you need one page — use `fetch`

## See Also

- [wigolo-fetch](../wigolo-fetch/SKILL.md) — for single pages
- [wigolo-find-similar](../wigolo-find-similar/SKILL.md) — discover related content after crawling
- [wigolo-cache](../wigolo/SKILL.md) — query the cache after crawling
