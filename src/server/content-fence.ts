// Deliberately imports ONLY the wrapper. The marker constants are not imported here: reading a
// marker out of a payload is exactly the content-derived decision rule 1 forbids (see header).
import { wrapUntrusted } from '../security/untrusted.js';
import type {
  AgentOutput,
  CacheOutput,
  Citation,
  CrawlOutput,
  DiffOutput,
  EvidenceItem,
  ExtractOutput,
  FetchOutput,
  FindSimilarOutput,
  Highlight,
  MapOutput,
  ResearchBrief,
  ResearchOutput,
  SearchOutput,
  TableData,
} from '../types.js';

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
 *
 * P2: every wrap carries a FRESH per-call nonce and, where one is in scope, the source's ORIGIN — so a bulk
 * result gets one nonce per page (never a shared one across `pages[]`), and the reading model can see which
 * host each region came from. An origin is genuinely absent for html-input extracts and inline diffs; those
 * omit it rather than inventing a value.
 *
 * ── TWO RULES THIS FILE EXISTS TO ENFORCE (B1/B2 — read before adding an exemption) ──
 *
 * 1. NEVER decide whether to fence by inspecting the value. The values here are page-derived, so any
 *    content-derived predicate hands the attacker the control's decision input. This was shipped and
 *    caught: a `report.includes(<opening marker prefix>)` guard meant a page that merely PRINTED those
 *    characters disabled the fence for the whole report — forging nothing. Making the predicate
 *    stricter does not fix it; the payload is byte-exact, so a page can reproduce a full nonce-matched
 *    region verbatim. The only safe decision is no decision: fence unconditionally.
 *
 * 2. To make rule 1 possible, NO RESPONSE-BOUND PRODUCER MAY EMIT A FENCE. Fencing upstream is what
 *    forces the seam to ask "is this already fenced?" in the first place. Response producers
 *    (buildFallbackReport, buildFallbackSynthesis, research citation snippets) all emit plain text;
 *    this seam is the sole place a response-bound value is wrapped. PROMPT-bound producers are the
 *    opposite and keep their fences (buildUntrustedSourceBlocks, synthesis-local, answer-synthesis) —
 *    different sink, and nothing there flows into a response.
 *
 * Corollary, learned the hard way TWICE: an "already fenced upstream" exemption is only ever valid if
 * it holds for EVERY producer of that field, not the LLM one. Both times the exemption was written the
 * keyless producer wove raw page text straight in. Audit all producers, or do not exempt.
 */

/** Fence a page-derived string, attributing it to `origin` when one is in scope. */
function fence(value: string, origin?: string): string {
  return wrapUntrusted(value, origin !== undefined && origin !== '' ? { origin } : undefined);
}

/**
 * Fence an OPTIONAL page-derived field: absent, non-string, and empty values pass through unchanged.
 * Empty is skipped deliberately — several handlers blank a body on the way out (research clears
 * `markdown_content` unless include_full_markdown), and fencing '' would emit a full `(empty)` region
 * per source for no gain. A non-empty string is always fenced (fail-closed).
 */
function fenceOptional<T>(value: T, origin?: string): T | string {
  return typeof value === 'string' && value.length > 0 ? fence(value, origin) : value;
}

/** EvidenceItem: excerpt / title / section_heading are page-derived; url + ids + score + span are operational. */
function fenceEvidence(items: EvidenceItem[] | undefined, fallbackOrigin?: string): EvidenceItem[] | undefined {
  if (!Array.isArray(items)) return items;
  return items.map((e) => {
    const origin = typeof e.url === 'string' && e.url !== '' ? e.url : fallbackOrigin;
    return {
      ...e,
      title: fenceOptional(e.title, origin) as string,
      excerpt: fenceOptional(e.excerpt, origin) as string,
      section_heading: fenceOptional(e.section_heading, origin) as string | null,
    };
  });
}

/** Highlight: text / source_title / section_heading are page-derived; source_url + indices are operational. */
function fenceHighlights(items: Highlight[] | undefined): Highlight[] | undefined {
  if (!Array.isArray(items)) return items;
  return items.map((h) => ({
    ...h,
    text: fenceOptional(h.text, h.source_url) as string,
    source_title: fenceOptional(h.source_title, h.source_url) as string,
    section_heading: fenceOptional(h.section_heading, h.source_url) as string | null | undefined,
  }));
}

/**
 * Citation titles + snippets — both always fenced here.
 *
 * F1: this used to take a `snippetAlreadyFenced` flag, passed `true` for research because
 * research/synthesize.ts fenced its snippets upstream. That was fail-OPEN: research has TWO citation
 * producers, and the local-LLM path (research/pipeline.ts, reached via WIGOLO_LOCAL_LLM or any
 * provider routing through synthesizeLocal) rebuilds the array with a raw
 * `stripResearchChrome(...).slice(0, 200)` snippet. The flag skipped it, so a hostile snippet shipped
 * bare beside its own fenced `title`. The producer-side fence is gone and the seam now fences
 * unconditionally: one invariant at one choke point, rather than an assumption every future producer
 * must remember.
 */
function fenceCitations(items: Citation[] | undefined): Citation[] | undefined {
  if (!Array.isArray(items)) return items;
  return items.map((c) => ({
    ...c,
    title: fenceOptional(c.title, c.url) as string,
    snippet: fenceOptional(c.snippet, c.url) as string,
  }));
}

export function fenceFetchData(data: FetchOutput): FetchOutput {
  const origin = data.url;
  const out: FetchOutput = {
    ...data,
    ...(typeof data.markdown === 'string' ? { markdown: fence(data.markdown, origin) } : {}),
    // `document.title` and the meta description are fully attacker-controlled and were returned raw.
    title: fenceOptional(data.title, origin) as string,
    // F4: hand-picking `description` left og_type / date / keywords raw, while the extract seam's own
    // OPERATIONAL_KEYS comment declares those exact keys fail-CLOSED. Same keys, two policies. Route
    // metadata through the same deep-fence so there is one policy; canonical_url and og_image are on
    // the allowlist and stay raw for free.
    ...(data.metadata && typeof data.metadata === 'object'
      ? { metadata: fenceDeepValue(data.metadata, false, 0, origin) as FetchOutput['metadata'] }
      : {}),
    ...(data.evidence ? { evidence: fenceEvidence(data.evidence, origin) } : {}),
    // site_data is per-site JSON lifted straight off the page (Reddit/YouTube/Amazon) — deep-fence its
    // string leaves with the same operational-key allowlist the extract seam uses.
    ...(data.site_data && typeof data.site_data === 'object'
      ? { site_data: fenceDeepValue(data.site_data, false, 0, origin) as Record<string, unknown> }
      : {}),
  };
  return out;
}

export function fenceCrawlData(data: CrawlResult): CrawlResult {
  // mode='map' returns URLs only (no `pages`) — nothing page-derived to fence.
  if (!('pages' in data) || !Array.isArray(data.pages)) return data;
  return {
    ...data,
    // One FRESH nonce per page — never shared across `pages[]`, or one page's close marker would
    // terminate another page's region.
    pages: data.pages.map((p) => ({
      ...p,
      ...(typeof p.markdown === 'string' ? { markdown: fence(p.markdown, p.url) } : {}),
      title: fenceOptional(p.title, p.url) as string,
      ...(p.excerpt !== undefined ? { excerpt: fenceOptional(p.excerpt, p.url) as string } : {}),
      ...(p.evidence ? { evidence: fenceEvidence(p.evidence, p.url) } : {}),
    })),
  };
}

function fenceTable(t: TableData, origin?: string): TableData {
  return {
    ...t,
    ...(typeof t.caption === 'string' ? { caption: fence(t.caption, origin) } : {}),
    headers: Array.isArray(t.headers) ? t.headers.map((h) => fence(h, origin)) : t.headers,
    rows: Array.isArray(t.rows)
      ? t.rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === 'string' ? fence(v, origin) : v])))
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
function fenceDeepValue(value: unknown, rawLeaf: boolean, depth: number, origin?: string): unknown {
  if (typeof value === 'string') return rawLeaf ? value : fence(value, origin);
  if (depth >= MAX_FENCE_DEPTH) return value;
  if (Array.isArray(value)) return value.map((v) => fenceDeepValue(v, rawLeaf, depth + 1, origin));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = fenceDeepValue(v, isOperationalKey(k), depth + 1, origin);
    return out;
  }
  return value;
}

export function fenceExtractData(data: ExtractOutput): ExtractOutput {
  // `source_url` is OPTIONAL — absent for html-input extracts, where there is no origin to name.
  const origin = data.source_url;
  // D7/A flat string; D7/B structured ARRAYS (string[] selector-multi, TableData[] tables) — per-content-field.
  if (typeof data.data === 'string') {
    return { ...data, data: fence(data.data, origin) };
  }
  if (Array.isArray(data.data)) {
    const fenced = data.data.map((item) => (typeof item === 'string' ? fence(item, origin) : fenceTable(item as TableData, origin)));
    return { ...data, data: fenced as ExtractOutput['data'] };
  }
  // D16: deep object shapes (MetadataData / StructuredData / arbitrary json-ld Records) — recursively fence
  // string leaves except under a known-operational key; UNKNOWN keys fail CLOSED (fenced). Shape preserved.
  if (data.data !== null && typeof data.data === 'object') {
    return { ...data, data: fenceDeepValue(data.data, false, 0, origin) as ExtractOutput['data'] };
  }
  return data;
}

export function fenceFindSimilarData(data: FindSimilarOutput): FindSimilarOutput {
  return {
    ...data,
    ...(Array.isArray(data.results)
      ? {
          results: data.results.map((r) => ({
            ...r,
            title: typeof r.title === 'string' ? fence(r.title, r.url) : r.title,
            markdown: typeof r.markdown === 'string' ? fence(r.markdown, r.url) : r.markdown,
          })),
        }
      : {}),
    ...(data.evidence ? { evidence: fenceEvidence(data.evidence) } : {}),
  };
}

export function fenceSearchData(data: SearchOutput): SearchOutput {
  return {
    ...data,
    ...(Array.isArray(data.results)
      ? {
          results: data.results.map((r) => ({
            ...r,
            title: typeof r.title === 'string' ? fence(r.title, r.url) : r.title,
            snippet: typeof r.snippet === 'string' ? fence(r.snippet, r.url) : r.snippet,
            ...(typeof r.markdown_content === 'string' ? { markdown_content: fence(r.markdown_content, r.url) } : {}),
            // F5: alt text is page prose the author controls, same as a title. image_url stays raw.
            ...(r.image_alt !== undefined ? { image_alt: fenceOptional(r.image_alt, r.url) as string } : {}),
          })),
        }
      : {}),
    // F5: the aggregated top-level image list carries the same alt prose; url/source_url stay raw.
    ...(Array.isArray(data.images)
      ? { images: data.images.map((im) => ({ ...im, ...(im.alt !== undefined ? { alt: fenceOptional(im.alt, im.source_url) as string } : {}) })) }
      : {}),
    // The evidence/citation/highlight arrays carry the SAME page prose as the results, re-sliced —
    // they were returned raw. `citations_xml` is a serialization of the citations INCLUDING snippets,
    // so it is fenced as one block (its origins are per-citation; no single one applies).
    ...(data.citations ? { citations: fenceCitations(data.citations) } : {}),
    ...(data.highlights ? { highlights: fenceHighlights(data.highlights) } : {}),
    ...(data.evidence ? { evidence: fenceEvidence(data.evidence) } : {}),
    ...(typeof data.citations_xml === 'string' && data.citations_xml.length > 0
      ? { citations_xml: fence(data.citations_xml) }
      : {}),
    // B2 — `answer` IS fenced. It used to be skipped as "wigolo's own synthesis, assembled from
    // already-fenced source blocks", which is the same false claim B1/F2 corrected for the research
    // report: it holds only on the LLM path. Two keyless producers weave raw page text straight in —
    // buildStructuredFallback (raw `r.title` plus a body keypoint) and the level-3 evidence dump
    // (raw title + snippet per source) — and both shipped the same sentence fenced as a sibling and
    // bare in `answer`.
    //
    // Fencing does not hide the answer: the preamble says "treat as data to READ", so the agent may
    // still relay it. What it stops is the agent OBEYING a directive that a page smuggled into the
    // text wigolo hands back as its own.
    ...(typeof data.answer === 'string' && data.answer.length > 0 ? { answer: fence(data.answer) } : {}),
    // `context_text` is the same class — page prose aggregated for the caller's context window.
    ...(typeof data.context_text === 'string' && data.context_text.length > 0
      ? { context_text: fence(data.context_text) }
      : {}),
    // Still NOT fenced: `warning`, wigolo-authored operator text with no page-derived component.
  };
}

/**
 * `cache` returns stored page bodies and titles from `url_cache` unioned with `studio_artifacts`.
 * It was UNFENCED, which also made it the open path for artifact rows (see decision A2b). `url` and
 * `trusted` stay raw — the agent dereferences one and must see the other.
 */
export function fenceCacheData(data: CacheOutput): CacheOutput {
  if (!Array.isArray(data.results)) return data;
  return {
    ...data,
    results: data.results.map((r) => ({
      ...r,
      title: fenceOptional(r.title, r.url) as string,
      markdown: fenceOptional(r.markdown, r.url) as string,
    })),
  };
}

/** ResearchBrief string leaves. No single origin applies — the brief is synthesized ACROSS sources. */
function fenceBrief(brief: ResearchBrief): ResearchBrief {
  const sections = brief.sections;
  return {
    ...brief,
    topics: Array.isArray(brief.topics) ? brief.topics.map((t) => fenceOptional(t) as string) : brief.topics,
    key_findings: Array.isArray(brief.key_findings) ? brief.key_findings.map((k) => fenceOptional(k) as string) : brief.key_findings,
    ...(brief.highlights ? { highlights: fenceHighlights(brief.highlights) as Highlight[] } : {}),
    ...(brief.citation_graph
      ? { citation_graph: brief.citation_graph.map((c) => ({ ...c, claim: fenceOptional(c.claim) as string })) }
      : {}),
    ...(sections && typeof sections === 'object'
      ? {
          sections: {
            ...sections,
            overview: {
              ...sections.overview,
              key_findings: Array.isArray(sections.overview?.key_findings)
                ? sections.overview.key_findings.map((k) => fenceOptional(k) as string)
                : sections.overview?.key_findings,
              cross_references: Array.isArray(sections.overview?.cross_references)
                ? sections.overview.cross_references.map((x) => ({ ...x, finding: fenceOptional(x.finding) as string }))
                : sections.overview?.cross_references,
            },
            ...(sections.comparison
              ? {
                  comparison: {
                    ...sections.comparison,
                    entities: sections.comparison.entities?.map((e) => fenceOptional(e) as string),
                    comparison_points: sections.comparison.comparison_points?.map((c) => fenceOptional(c) as string),
                    tradeoffs: sections.comparison.tradeoffs?.map((t) => ({
                      ...t,
                      text: fenceOptional(t.text) as string,
                      term: fenceOptional(t.term) as string,
                    })),
                  },
                }
              : {}),
            gaps: Array.isArray(sections.gaps)
              ? sections.gaps.map((g) => (typeof g === 'string' ? (fenceOptional(g) as string) : { ...g, reason: fenceOptional(g.reason) as string }))
              : sections.gaps,
          },
        }
      : {}),
  };
}

/**
 * `research` was UNFENCED at the dispatch envelope even though its sources, evidence and brief carry
 * page prose verbatim.
 *
 * B1 — `report` is fenced UNCONDITIONALLY. The previous attempt inspected the value
 * (an `includes(<opening marker prefix>)` test) to avoid double-wrapping the one producer that emitted
 * fences. That was a control whose decision input the attacker writes: `renderBriefReport` weaves raw
 * page sentences into the report, so a page that merely PRINTED those 29 characters switched the
 * fence off for the entire report — no nonce, no terminator, no forgery of any kind required. A
 * stronger predicate would not have saved it either: the payload is byte-exact, so a page can emit a
 * complete nonce-matched region verbatim.
 *
 * The decision is therefore deleted rather than hardened. `buildFallbackReport` no longer fences its
 * source bodies, so NO response-bound producer emits a fence, so the seam never has to ask. See the
 * module header: response producers stay fence-free; prompt producers keep theirs.
 */
export function fenceResearchData(data: ResearchOutput): ResearchOutput {
  return {
    ...data,
    ...(typeof data.report === 'string' && data.report.length > 0 ? { report: fence(data.report) } : {}),
    ...(Array.isArray(data.sources)
      ? {
          sources: data.sources.map((s) => ({
            ...s,
            title: fenceOptional(s.title, s.url) as string,
            markdown_content: fenceOptional(s.markdown_content, s.url) as string,
          })),
        }
      : {}),
    ...(data.citations ? { citations: fenceCitations(data.citations) as Citation[] } : {}),
    ...(data.evidence ? { evidence: fenceEvidence(data.evidence) } : {}),
    ...(data.brief ? { brief: fenceBrief(data.brief) } : {}),
  };
}

/**
 * `agent` was UNFENCED across its per-source markdown, titles and step log.
 *
 * `rawHtml` is fenced too, but as defence in depth rather than a live hole: `stripRawHtml`
 * (src/agent/pipeline.ts) deletes the field on every return path of runAgentPipeline, so it does not
 * reach a caller today. The field is still declared optional on AgentSource, so the fence is here to
 * fail CLOSED if that strip is ever relaxed or an AgentOutput is assembled by another producer.
 *
 * B1 — `result` is fenced in BOTH shapes, unconditionally. The string form used to be skipped as
 * "already fence-bearing", which is the same defect as the research report: `buildFallbackSynthesis`
 * is only one of its producers, and leaving it fence-bearing forced a content-derived decision the
 * page could flip. That producer no longer fences, so the string is simply wrapped; the Record form
 * (schema path, page-extracted, never fenced upstream) is deep-fenced as before.
 */
export function fenceAgentData(data: AgentOutput): AgentOutput {
  return {
    ...data,
    ...(data.result !== null && typeof data.result === 'object'
      ? { result: fenceDeepValue(data.result, false, 0) as Record<string, unknown> }
      : typeof data.result === 'string' && data.result.length > 0
        ? { result: fence(data.result) }
        : {}),
    ...(Array.isArray(data.sources)
      ? {
          sources: data.sources.map((s) => ({
            ...s,
            title: fenceOptional(s.title, s.url) as string,
            markdown_content: fenceOptional(s.markdown_content, s.url) as string,
            ...(s.rawHtml !== undefined ? { rawHtml: fenceOptional(s.rawHtml, s.url) as string } : {}),
          })),
        }
      : {}),
    ...(Array.isArray(data.steps)
      ? { steps: data.steps.map((s) => ({ ...s, detail: fenceOptional(s.detail) as string })) }
      : {}),
    ...(data.evidence ? { evidence: fenceEvidence(data.evidence) } : {}),
  };
}

/**
 * `diff` returns verbatim page text on BOTH sides and was unfenced. `DiffOutput` carries no url, so
 * the origin comes from the caller's input when it named one; a diff of two inline markdown blobs has
 * no origin at all and omits it rather than inventing one. `notice` / `slice` are wigolo-authored.
 */
export function fenceDiffData(data: DiffOutput, origin?: string): DiffOutput {
  return {
    ...data,
    ...(typeof data.unified_diff === 'string' && data.unified_diff.length > 0
      ? { unified_diff: fence(data.unified_diff, origin) }
      : {}),
    ...(Array.isArray(data.hunks)
      ? {
          hunks: data.hunks.map((h) => ({
            ...h,
            before: fenceOptional(h.before, origin) as string,
            after: fenceOptional(h.after, origin) as string,
            ...(h.section_title !== undefined ? { section_title: fenceOptional(h.section_title, origin) as string } : {}),
          })),
        }
      : {}),
  };
}

/** Best-effort origin for a diff: whichever side named a url. Neither side is required to. */
export function diffOriginFromInput(input: Record<string, unknown>): string | undefined {
  for (const key of ['new', 'old']) {
    const side = input[key];
    if (side !== null && typeof side === 'object') {
      const url = (side as { url?: unknown }).url;
      if (typeof url === 'string' && url.length > 0) return url;
    }
  }
  return undefined;
}
