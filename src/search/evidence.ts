import { createHash } from 'node:crypto';
import type {
  Citation,
  CitationFormat,
  EvidenceItem,
  SearchInput,
  SearchOutput,
  SearchResultItem,
  SourceSpan,
} from '../types.js';
import { extractHighlights } from './highlights.js';
import { countTokens, truncateByTokens } from './tokens.js';
import { applyOutputBudget } from './truncate.js';
import { createLogger } from '../logger.js';

const log = createLogger('search');

const DEFAULT_MAX_TOKENS_OUT = 4000;
const MAX_EVIDENCE_PASSAGES = 20;
const TRUNCATION_MARKER = '[... content truncated]';

// M18: drop passages that are too short to be useful evidence.
const MIN_EVIDENCE_EXCERPT_CHARS = 40;
// M18: drop passages where markdown-link markup dominates the body.
const MAX_LINK_MARKUP_RATIO = 0.5;

// Returns true when the excerpt is genuine prose worth surfacing as evidence.
// Filters out (a) too-short snippets and (b) chunks that are mostly markdown
// link markup `[text](url)` — both common when extraction lands on
// nav/footer/sidebar blocks instead of real content.
function isUsefulEvidenceExcerpt(excerpt: string): boolean {
  const trimmed = excerpt.trim();
  if (trimmed.length < MIN_EVIDENCE_EXCERPT_CHARS) return false;
  // Match both markdown links `[text](url)` and bare URLs.
  const linkChars = (trimmed.match(/\[[^\]]*\]\([^)]*\)|https?:\/\/\S+/g) ?? [])
    .reduce((acc, match) => acc + match.length, 0);
  if (linkChars / trimmed.length > MAX_LINK_MARKUP_RATIO) return false;
  return true;
}

export interface BuildEvidenceOptions {
  maxTokensOut?: number;
  maxItems?: number;
  /** Mirrors the source result's trust onto every produced EvidenceItem (C4).
   * Defaults false — correct for page/web-derived callers (fetch/crawl/search/
   * research); find_similar passes the per-result `trusted`. */
  trusted?: boolean;
}

// Build evidence items from a single page's markdown. Used by per-page tools
// (fetch, crawl pages, find_similar results, agent/research sources). The
// returned list is already truncated to fit `maxTokensOut` if provided; pass
// `maxItems` to cap how many highlights are projected.
export async function buildEvidenceFromMarkdown(
  query: string,
  title: string,
  url: string,
  markdown: string,
  opts: BuildEvidenceOptions = {},
): Promise<EvidenceItem[]> {
  if (!markdown) return [];
  const maxItems = opts.maxItems ?? 1;
  const synthetic: SearchResultItem[] = [{
    title,
    url,
    snippet: '',
    markdown_content: markdown,
    relevance_score: 1,
  }];

  let result;
  try {
    result = await extractHighlights(query, synthetic, Math.max(maxItems, 1));
  } catch (err) {
    log.debug('buildEvidenceFromMarkdown: extractHighlights failed', { error: String(err) });
    return [];
  }

  const ranked = result.highlights
    .slice()
    .sort((a, b) => b.relevance_score - a.relevance_score)
    .slice(0, maxItems);

  const out: EvidenceItem[] = [];
  let used = 0;
  const budget = opts.maxTokensOut;
  for (const h of ranked) {
    let excerpt = h.text;
    if (budget !== undefined) {
      const remaining = budget - used;
      if (remaining <= 0) break;
      excerpt = truncateByTokens(h.text, remaining);
      if (!excerpt || excerpt.trim() === TRUNCATION_MARKER) break;
    }
    const span = h.source_span ?? { start: 0, end: excerpt.length };
    out.push(buildEvidenceItem({
      title: h.source_title || title,
      url: h.source_url || url,
      sectionHeading: h.section_heading ?? null,
      excerpt,
      score: h.relevance_score,
      sourceSpan: span,
      trusted: opts.trusted ?? false,
    }));
    if (budget !== undefined) used += countTokens(excerpt);
  }
  return out;
}

// Walk items in order, capping each item's body text against a shared token
// budget. Bodies past the budget are cleared (set to ''). Used by all
// multi-item tools (search markdown_content, find_similar, crawl, research,
// agent) so per-tool max_tokens_out is an aggregate cap, not per-item.
export function applyAggregateMarkdownBudget<T>(
  items: T[],
  getBody: (item: T) => string,
  setBody: (item: T, body: string) => void,
  opts: { maxTokensOut?: number; maxChars?: number },
): void {
  const budget = opts.maxTokensOut;
  let used = 0;
  for (const item of items) {
    const body = getBody(item);
    if (!body) continue;
    if (budget !== undefined) {
      const remaining = budget - used;
      if (remaining <= 0) {
        setBody(item, '');
        continue;
      }
      const trimmed = applyOutputBudget(body, { maxTokensOut: remaining, maxChars: opts.maxChars });
      setBody(item, trimmed);
      used += countTokens(trimmed);
    } else {
      const trimmed = applyOutputBudget(body, { maxChars: opts.maxChars });
      setBody(item, trimmed);
    }
  }
}

// Apply an aggregate token budget across an already-built list of evidence
// items, truncating excerpts in order until the budget is exhausted. Items
// past the budget are dropped.
export function applyTokenBudget(items: EvidenceItem[], maxTokensOut: number): EvidenceItem[] {
  if (maxTokensOut <= 0) return [];
  const out: EvidenceItem[] = [];
  let used = 0;
  for (const item of items) {
    const remaining = maxTokensOut - used;
    if (remaining <= 0) break;
    const excerpt = truncateByTokens(item.excerpt, remaining);
    if (!excerpt) break;
    out.push({ ...item, excerpt });
    used += countTokens(excerpt);
  }
  return out;
}

export function stableCitationId(url: string, start: number): string {
  return createHash('sha1').update(`${url}#${start}`).digest('hex').slice(0, 12);
}

export function buildEvidenceItem(input: {
  title: string;
  url: string;
  sectionHeading: string | null;
  excerpt: string;
  score: number;
  sourceSpan: SourceSpan;
  trusted?: boolean;
}): EvidenceItem {
  return {
    title: input.title,
    url: input.url,
    section_heading: input.sectionHeading,
    excerpt: input.excerpt,
    score: input.score,
    citation_id: stableCitationId(input.url, input.sourceSpan.start),
    source_span: input.sourceSpan,
    trusted: input.trusted ?? false,
  };
}

export async function applyEvidenceDefault(
  input: SearchInput,
  output: SearchOutput,
  results: SearchResultItem[],
  query: string,
): Promise<void> {
  if (results.length === 0) return;

  const includeFullMarkdown = input.include_full_markdown ?? false;
  const citationFormat: CitationFormat = input.citation_format ?? 'numbered';
  const maxTokensOut = input.max_tokens_out ?? DEFAULT_MAX_TOKENS_OUT;

  let highlightsResult;
  try {
    highlightsResult = await extractHighlights(query, results, MAX_EVIDENCE_PASSAGES);
  } catch (err) {
    log.debug('evidence extraction failed', { error: String(err) });
    const msg = 'evidence extraction failed; results returned without highlights';
    output.warning = output.warning ? `${output.warning}; ${msg}` : msg;
    highlightsResult = { highlights: [], citations: [], reranker_used: false };
  }

  const ranked = highlightsResult.highlights
    .slice()
    .sort((a, b) => b.relevance_score - a.relevance_score);

  // When the caller sets max_tokens_out explicitly, evidence shares the budget
  // with citations/results metadata. Reserve room for the structural overhead
  // so the total stringified output stays under the cap.
  // NOTE: this relies on JSON.stringify dropping `undefined` keys, and on
  // applyEvidenceDefault running before any post-evidence mutation that grows
  // the skeleton (e.g. output.warning); reserve overhead first, mutate later.
  let evidenceBudget = maxTokensOut;
  if (input.max_tokens_out !== undefined) {
    const skeleton: SearchOutput = { ...output, citations: undefined, evidence: undefined, citations_xml: undefined };
    const skeletonTokens = countTokens(JSON.stringify(skeleton));
    const resultsTokens = countTokens(JSON.stringify(results));
    const overhead = skeletonTokens + resultsTokens;
    evidenceBudget = Math.max(0, maxTokensOut - overhead);
  }

  // H1: when the caller passes max_results, cap evidence at that count so the
  // response shape mirrors what they asked for. M18: drop short / link-heavy
  // excerpts BEFORE the cap so the budget reserves slots for genuine prose.
  const maxEvidence = input.max_results !== undefined
    ? Math.max(0, Math.floor(input.max_results))
    : Infinity;

  const evidence: EvidenceItem[] = [];
  let usedTokens = 0;
  for (const h of ranked) {
    if (evidence.length >= maxEvidence) break;
    if (usedTokens >= evidenceBudget) break;
    const remaining = evidenceBudget - usedTokens;
    const excerpt = truncateByTokens(h.text, remaining);
    if (!excerpt) continue;
    if (!isUsefulEvidenceExcerpt(excerpt)) continue;
    const span = h.source_span ?? { start: 0, end: excerpt.length };
    const item = buildEvidenceItem({
      title: h.source_title,
      url: h.source_url,
      sectionHeading: h.section_heading ?? null,
      excerpt,
      score: h.relevance_score,
      sourceSpan: span,
    });
    evidence.push(item);
    usedTokens += countTokens(excerpt);
  }

  if (evidence.length > 0) {
    output.evidence = evidence;
  }

  const citations = buildCitationsFromEvidence(results, evidence, highlightsResult.citations);

  if (citationFormat === 'numbered' || citationFormat === 'json') {
    if (citations.length > 0) output.citations = citations;
  } else if (citationFormat === 'anthropic_tags') {
    if (citations.length > 0) {
      output.citations = citations;
      output.citations_xml = renderCitationsXml(citations);
    }
  }

  // Terminal mutation: applyEvidenceDefault is the last step before return.
  if (!includeFullMarkdown) {
    for (const r of results) {
      if (r.markdown_content !== undefined) r.markdown_content = undefined;
    }
  } else if (input.max_tokens_out !== undefined) {
    // Aggregate cap across all results in score order — sum of markdown_content
    // tokens stays under max_tokens_out; bodies past the budget are dropped.
    applyAggregateMarkdownBudget(
      results,
      (r) => (typeof r.markdown_content === 'string' ? r.markdown_content : ''),
      (r, body) => { r.markdown_content = body; },
      { maxTokensOut: input.max_tokens_out },
    );
  }
}

export function buildCitationsFromEvidence(
  results: SearchResultItem[],
  evidence: EvidenceItem[],
  baseCitations: Citation[],
): Citation[] {
  // Pick the primary citation_id per source: the first evidence item for that URL
  // (highest score after sort). Sources whose evidence was budget-cut have no
  // citation_id — consumers can interpret missing id as "source-level citation,
  // no specific passage."
  const primaryByUrl = new Map<string, string>();
  for (const ev of evidence) {
    if (!primaryByUrl.has(ev.url)) primaryByUrl.set(ev.url, ev.citation_id);
  }
  const baseByUrl = new Map<string, Citation>();
  for (const c of baseCitations) baseByUrl.set(c.url, c);

  const out: Citation[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const base = baseByUrl.get(r.url);
    const citation: Citation = base
      ? { ...base }
      : {
          index: i + 1,
          url: r.url,
          title: r.title,
          snippet: r.snippet ?? '',
        };
    const primary = primaryByUrl.get(r.url);
    if (primary !== undefined) {
      citation.citation_id = primary;
    } else {
      // No surviving evidence passage for this source — leave citation_id absent.
      delete citation.citation_id;
    }
    out.push(citation);
  }
  return out;
}

export function renderCitationsXml(citations: Citation[]): string {
  return citations
    .map((c) => {
      const id = c.citation_id ?? stableCitationId(c.url, 0);
      const inner = escapeXml(`${c.title}\n${c.url}\n${c.snippet}`);
      return `<source id="${id}">${inner}</source>`;
    })
    .join('\n');
}

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
