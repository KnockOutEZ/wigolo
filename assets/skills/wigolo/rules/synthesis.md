---
name: wigolo-synthesis
description: How to synthesize answers and reports from wigolo's structured output formats.
---

# Synthesis Patterns

Wigolo has no internal LLM — it returns structured evidence. You (the host LLM) write the final answer.

## From highlights (`search` with `format: "highlights"`)

Wigolo returns ML-scored passages with `[N]` citation indices.

1. Read the passages — already ranked by relevance
2. Group overlapping themes across sources
3. Write your answer citing [1], [2] etc.
4. The `citations` array maps indices to URLs

```json
search({ "query": "react server components patterns", "format": "highlights", "max_highlights": 6 })
// Returns: { highlights: [{passage, score, citation_index}], citations: [{index, url, title}] }
// → Write answer citing [1], [2], etc.
```

## From research briefs (`research` tool)

When MCP sampling is unavailable (common), the output carries a `brief`:

| Field | Use |
|-------|-----|
| `key_findings` | Top passages across all sources — start executive summary here |
| `topics` | Sources grouped by sub-query — write per-topic sections |
| `cross_references` | Findings corroborated by 2+ sources — most reliable, cite first |
| `comparison` | Entity-specific points (for X vs Y queries) — build comparison table |
| `gaps` | Sub-queries with limited coverage — note as limitations |

Report structure:
1. Executive summary from `key_findings`
2. Cross-referenced findings (cite as "corroborated by N sources")
3. Per-topic sections from `topics`
4. Comparison table from `comparison` (if present)
5. Limitations from `gaps`
6. Sources with [N] citation format
