---
name: wigolo-extract
description: |
  Extract structured data from any webpage — tables, definition lists, key-value pairs, JSON-LD, and chart descriptions. Use when the user wants structured data, pricing tables, feature comparisons, or says "extract the table", "get structured data", "pull the pricing", "extract as JSON".
---

# wigolo extract

Structured data extraction beyond simple markdown.

## Quick Reference

```json
// Full structured extraction (ALWAYS prefer this)
{ "url": "https://bun.sh", "mode": "structured" }

// JSON Schema extraction — heuristic field matching
{ "url": "https://example.com/pricing", "mode": "schema", "schema": { "type": "object", "properties": { "name": { "type": "string" }, "price": { "type": "string" }, "sku": { "type": "string" } } } }

// CSS selector extraction
{ "url": "https://example.com", "mode": "selector", "css_selector": ".product-card", "multiple": true }

// Metadata only
{ "url": "https://example.com", "mode": "metadata" }

// From raw HTML
{ "html": "<table>...</table>", "mode": "tables" }
```

## Modes

| Mode | What it extracts | When to use |
|------|-----------------|-------------|
| `structured` | Tables + definition lists + JSON-LD + chart hints + key-value pairs | **Default choice — use this** |
| `tables` | HTML tables only | When you specifically need only tables |
| `schema` | Fields matching a JSON Schema | When you know the exact fields you want |
| `metadata` | OpenGraph, meta tags, JSON-LD | For page metadata only |
| `selector` | CSS selector matches | When you know the exact CSS selector |

**Always use `mode: "structured"` instead of `mode: "tables"`.** Structured captures everything tables does, plus definitions, key-value pairs, JSON-LD, and chart descriptions.

## Chart Hints

When a page has visual charts (SVG, Canvas), `chart_hints` contains text descriptions extracted from aria-labels, SVG titles, and figcaptions. Use these to describe visual data even when the underlying data is JavaScript-rendered.

## Schema Mode

`mode: "schema"` does heuristic matching over CSS classes, ARIA labels, microdata, and JSON-LD — no LLM required. Pass `{ properties: { field: { type: "string" } } }`.

## Anti-Patterns

- DON'T use `mode: "tables"` — use `mode: "structured"` instead
- DON'T pass a schema without `properties` key — handler rejects it
- DON'T extract for a whole page when you need markdown — use `fetch` instead

## See Also

- [wigolo-fetch](../wigolo-fetch/SKILL.md) — for markdown content
- [wigolo-agent](../wigolo-agent/SKILL.md) — for AI-powered multi-page extraction
