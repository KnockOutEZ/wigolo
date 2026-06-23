import { wrapUntrusted } from '../security/untrusted.js';
import type { FetchOutput, CrawlOutput, ExtractOutput, MapOutput, FindSimilarOutput, SearchOutput, TableData } from '../types.js';

/** handleCrawl returns a crawl OR a map (mode='map', URL-list only, no page bodies). */
type CrawlResult = CrawlOutput | (MapOutput & { crawled: number });

/**
 * D7 — fence raw content-tool results returned to the AGENT in the [[UNTRUSTED DATA]] fence (the WIDE
 * boundary, symmetric to R1's synthesis-input fence). Applied at the MCP dispatch envelope ONLY (agent-
 * facing): the REPL/human path uses the handlers directly, and the research/agent pipelines gather via the
 * domain producers + fence at synthesis (R1) — neither reaches here. So the fence is WRAP-ONCE by placement
 * (no double-fence, no human-output pollution); see content-fence.test.ts PIN-A4.
 *
 * D7/A fences FLAT-MARKDOWN bodies (fetch/crawl/extract-as-string); D7/B fences the per-content fields of the
 * STRUCTURED returns (search/find_similar/extract-tables) while leaving operational fields (url/id/score) raw.
 */

export function fenceFetchData(data: FetchOutput): FetchOutput {
  return typeof data.markdown === 'string' ? { ...data, markdown: wrapUntrusted(data.markdown) } : data;
}

export function fenceCrawlData(data: CrawlResult): CrawlResult {
  // mode='map' returns URLs only (no `pages`) — nothing page-derived to fence.
  if (!('pages' in data) || !Array.isArray(data.pages)) return data;
  return {
    ...data,
    pages: data.pages.map((p) => (typeof p.markdown === 'string' ? { ...p, markdown: wrapUntrusted(p.markdown) } : p)),
  };
}

function fenceTable(t: TableData): TableData {
  return {
    ...t,
    ...(typeof t.caption === 'string' ? { caption: wrapUntrusted(t.caption) } : {}),
    headers: Array.isArray(t.headers) ? t.headers.map((h) => wrapUntrusted(h)) : t.headers,
    rows: Array.isArray(t.rows)
      ? t.rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === 'string' ? wrapUntrusted(v) : v])))
      : t.rows,
  };
}

// D16: keys whose string values are OPERATIONAL (URLs/URIs/identity the agent dereferences or matches by) —
// kept RAW so the agent can still act on them. Everything else fails CLOSED (fenced). Grounded in the extract
// type shapes (MetadataData canonical_url / og_image) + schema.org json-ld conventions (@id/@type/@context/
// url/sameAs/contentUrl/embedUrl/...). Matched case-insensitively. Ambiguous or page-classifier keys
// (source / og_type / type_hint / date / keywords) are deliberately NOT operational → fail-closed (fenced).
const OPERATIONAL_KEYS = new Set<string>([
  'url', 'href', '@id', '@type', '@context', 'identifier', 'sameas',
  'contenturl', 'embedurl', 'thumbnailurl', 'image', 'logo',
  'mainentityofpage', 'target', 'additionaltype', 'canonical_url', 'og_image',
]);

// Bound the descent into nested objects/arrays (cyclic-ref / pathological-nesting guard). Real extract objects
// are shallow; the bound only stops runaway descent — string leaves are fenced regardless of depth (below).
const MAX_FENCE_DEPTH = 16;

function isOperationalKey(key: string): boolean {
  return OPERATIONAL_KEYS.has(key.toLowerCase());
}

/**
 * D16: recursively fence the string leaves of a deep extract value. `rawLeaf` carries the parent key's
 * operational-ness onto string + array leaves (so `sameAs: [url, url]` stays raw); objects decide per-key.
 * String leaves are ALWAYS handled (fenced unless operational) regardless of depth — only the DESCENT into
 * nested objects/arrays is depth-bounded, so a cycle can't run away yet content is never left unfenced by the
 * bound. Object shape is rebuilt key-for-key (no flatten). Non-string scalars are not an injection vector.
 */
function fenceDeepValue(value: unknown, rawLeaf: boolean, depth: number): unknown {
  if (typeof value === 'string') return rawLeaf ? value : wrapUntrusted(value);
  if (depth >= MAX_FENCE_DEPTH) return value;
  if (Array.isArray(value)) return value.map((v) => fenceDeepValue(v, rawLeaf, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = fenceDeepValue(v, isOperationalKey(k), depth + 1);
    return out;
  }
  return value;
}

export function fenceExtractData(data: ExtractOutput): ExtractOutput {
  // D7/A flat string; D7/B structured ARRAYS (string[] selector-multi, TableData[] tables) — per-content-field.
  if (typeof data.data === 'string') {
    return { ...data, data: wrapUntrusted(data.data) };
  }
  if (Array.isArray(data.data)) {
    const fenced = data.data.map((item) => (typeof item === 'string' ? wrapUntrusted(item) : fenceTable(item as TableData)));
    return { ...data, data: fenced as ExtractOutput['data'] };
  }
  // D16: deep object shapes (MetadataData / StructuredData / arbitrary json-ld Records) — recursively fence
  // string leaves except under a known-operational key; UNKNOWN keys fail CLOSED (fenced). Shape preserved.
  if (data.data !== null && typeof data.data === 'object') {
    return { ...data, data: fenceDeepValue(data.data, false, 0) as ExtractOutput['data'] };
  }
  return data;
}

export function fenceFindSimilarData(data: FindSimilarOutput): FindSimilarOutput {
  if (!Array.isArray(data.results)) return data;
  return {
    ...data,
    results: data.results.map((r) => ({
      ...r,
      title: typeof r.title === 'string' ? wrapUntrusted(r.title) : r.title,
      markdown: typeof r.markdown === 'string' ? wrapUntrusted(r.markdown) : r.markdown,
    })),
  };
}

export function fenceSearchData(data: SearchOutput): SearchOutput {
  if (!Array.isArray(data.results)) return data;
  return {
    ...data,
    results: data.results.map((r) => ({
      ...r,
      title: typeof r.title === 'string' ? wrapUntrusted(r.title) : r.title,
      snippet: typeof r.snippet === 'string' ? wrapUntrusted(r.snippet) : r.snippet,
      ...(typeof r.markdown_content === 'string' ? { markdown_content: wrapUntrusted(r.markdown_content) } : {}),
    })),
  };
}
