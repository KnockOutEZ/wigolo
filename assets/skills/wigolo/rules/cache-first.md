---
name: wigolo-cache-first
description: Always check wigolo's local cache before making web requests.
---

# Cache-First Rule

Before ANY web search or fetch, check the cache:

```json
{ "query": "relevant keywords" }
```

Call the `cache` tool with the relevant keywords. If it has content, use it. If not, proceed to search/fetch.

Why: cached content is instant (0ms network), free (no SearXNG query), and already extracted (clean markdown). A cache miss costs nothing — a redundant fetch wastes 5-15 seconds.

After fetching or searching, content is automatically cached with embeddings for future `find_similar` queries.

## Example

```json
// Step 1: check cache
cache({ "query": "oauth2 pkce", "url_pattern": "*auth0.com*" })

// Step 2: if empty, search
search({ "query": "oauth2 pkce flow site:auth0.com", "include_domains": ["auth0.com"] })
```

Exceptions: `research` and `agent` check the cache internally — no pre-probe needed.
