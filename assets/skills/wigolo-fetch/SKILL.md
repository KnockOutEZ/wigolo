---
name: wigolo-fetch
description: |
  Fetch any URL and get clean markdown with metadata. Handles JavaScript-rendered SPAs, authenticated pages, PDFs, and content change detection. Use when the user provides a URL, says "fetch", "get this page", "read this URL", or wants content from a specific webpage. Supports auth via storage state, Chrome profile, or CDP.
---

# wigolo fetch

Smart URL fetching: HTTP-first with automatic browser fallback for JS-rendered pages.

## Quick Reference

```json
// Basic fetch
{ "url": "https://react.dev/reference/react/useState" }

// Fresh content (bypass cache)
{ "url": "https://news.ycombinator.com", "force_refresh": true }

// With authentication
{ "url": "https://app.example.com/dashboard", "use_auth": true }

// Section targeting (cheapest — reads one heading only)
{ "url": "https://docs.example.com/api", "section": "Authentication" }

// Compact context for AI
{ "url": "https://docs.example.com/api", "max_content_chars": 3000 }

// Browser actions before extraction
{ "url": "https://example.com", "actions": [{"type": "click", "selector": "#load-more"}, {"type": "wait", "ms": 1000}] }
```

## Parameters

| Parameter | Type | When to use |
|-----------|------|-------------|
| `url` | string | Required |
| `force_refresh` | boolean | For pages that change frequently (news, dashboards, changelogs) |
| `use_auth` | boolean | For authenticated pages (uses configured auth) |
| `render_js` | string | "auto" (default), "always" (force browser), "never" (HTTP only, fastest) |
| `section` | string | Extract only a named section — much cheaper than full page |
| `section_index` | number | Which heading match (default: 0) |
| `max_content_chars` | number | Smart-truncate at paragraph boundary with `[... content truncated]` marker |
| `screenshot` | boolean | Capture screenshot (default: false) |
| `headers` | object | Additional HTTP headers |
| `actions` | array | Browser actions: click, type, wait, wait_for, scroll, screenshot |

## Output

Returns clean markdown with:
- `title`, `markdown`, `links`, `images`
- Metadata: `og_type`, `canonical_url`, `og_image`, `og_description`
- `cached: true/false` — if from cache, repeat fetches are instant

## Anti-Patterns

- DON'T fetch a full page when you need one section — use `section: "Heading Name"`
- DON'T set `force_refresh: true` by default — defeats the cache
- DON'T use fetch when you need tables/JSON-LD — use `extract` instead

## See Also

- [wigolo-search](../wigolo-search/SKILL.md) — when you don't have a URL
- [wigolo-extract](../wigolo-extract/SKILL.md) — when you need structured data, not markdown
- [wigolo-crawl](../wigolo-crawl/SKILL.md) — when you need multiple pages from a site
