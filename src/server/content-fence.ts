import { wrapUntrusted } from '../security/untrusted.js';
import type { FetchOutput, CrawlOutput, ExtractOutput, MapOutput, FindSimilarOutput, SearchOutput } from '../types.js';

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

export function fenceExtractData(data: ExtractOutput): ExtractOutput {
  // D7/A: only the FLAT-STRING shape (e.g. mode=selector) is body-fenced here; structured shapes
  // (tables / json-ld / structured) are per-content-field fenced in D7/B.
  return typeof data.data === 'string' ? { ...data, data: wrapUntrusted(data.data) } : data;
}

// STUB (D7/B RED): identity — per-content-field fencing of the structured array returns lands in GREEN.
export function fenceFindSimilarData(data: FindSimilarOutput): FindSimilarOutput {
  return data;
}

export function fenceSearchData(data: SearchOutput): SearchOutput {
  return data;
}
