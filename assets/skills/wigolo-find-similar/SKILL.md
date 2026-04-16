---
name: wigolo-find-similar
description: |
  Find semantically similar content using hybrid search (embeddings + keywords + web). Use when the user has a good source and wants more like it, says "find similar", "related pages", "more like this", or wants to discover content related to a known URL or concept. Works best after crawling or fetching several pages.
---

# wigolo find_similar

Hybrid semantic discovery: semantic embeddings + keyword search + web search, fused via Reciprocal Rank Fusion (RRF).

## Quick Reference

```json
// Find pages similar to a URL
{ "url": "https://docs.astro.build/en/getting-started/" }

// Find pages related to a concept
{ "concept": "JavaScript framework server-side rendering" }

// Scoped to specific domains
{ "url": "https://react.dev/reference/react/use", "include_domains": ["vuejs.org", "svelte.dev"] }

// Cache-only (no web fallback)
{ "url": "https://example.com/page", "include_web": false }
```

## Parameters

| Parameter | Type | Default | When to use |
|-----------|------|---------|-------------|
| `url` | string | — | Find pages similar to this URL's content |
| `concept` | string | — | Find pages related to a text concept (no URL needed) |
| `max_results` | number | 10 | Cap at 50 |
| `include_domains` | string[] | none | Scope results to specific sites |
| `exclude_domains` | string[] | none | Filter out domains |
| `include_cache` | boolean | true | Search local cache (fast, free) |
| `include_web` | boolean | true | Web fallback when cache is sparse |

Provide either `url` or `concept` (not both).

## How It Works

1. Embeds the input (URL content or concept text) into a vector
2. Searches local cache via embedding similarity + keyword matching
3. Falls back to web search if local hits are sparse
4. Fuses all signals via 3-way Reciprocal Rank Fusion (RRF)
5. Returns ranked results with `match_signals` (embedding_rank, fts5_rank, fused_score)

## Important: Build the Cache First

find_similar works best with a warm cache. Recommended workflow:

```json
// Step 1: crawl to populate cache with embeddings
{ "url": "https://docs.framework.dev", "strategy": "sitemap", "max_pages": 20 }

// Step 2: now find_similar has real semantic signal
{ "url": "https://docs.framework.dev/getting-started" }
```

On a cold cache, the response includes a `cold_start` string — pass it verbatim to the user, it explains why results came from web search.

## Anti-Patterns

- DON'T use find_similar on a fresh install expecting embedding results — crawl first
- DON'T provide both `url` and `concept` — pick one
- DON'T use when you want web results — use `search` instead

## See Also

- [wigolo-crawl](../wigolo-crawl/SKILL.md) — build the cache first
- [wigolo-search](../wigolo-search/SKILL.md) — when you want web results, not cache similarity
