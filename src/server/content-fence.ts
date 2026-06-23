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

export function fenceExtractData(data: ExtractOutput): ExtractOutput {
  // D7/A flat string; D7/B structured ARRAYS (string[] selector-multi, TableData[] tables) — per-content-field.
  // Object shapes (StructuredData / MetadataData / arbitrary json-ld Records) carry deeper nested text and are
  // NOT traversed here — a noted D7 residual (deep arbitrary traversal is D8-structural-isolation territory).
  if (typeof data.data === 'string') {
    return { ...data, data: wrapUntrusted(data.data) };
  }
  if (Array.isArray(data.data)) {
    const fenced = data.data.map((item) => (typeof item === 'string' ? wrapUntrusted(item) : fenceTable(item as TableData)));
    return { ...data, data: fenced as ExtractOutput['data'] };
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
