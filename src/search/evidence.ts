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
import { createLogger } from '../logger.js';

const log = createLogger('search');

const DEFAULT_MAX_TOKENS_OUT = 4000;
const MAX_EVIDENCE_PASSAGES = 20;

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
}): EvidenceItem {
  return {
    title: input.title,
    url: input.url,
    section_heading: input.sectionHeading,
    excerpt: input.excerpt,
    score: input.score,
    citation_id: stableCitationId(input.url, input.sourceSpan.start),
    source_span: input.sourceSpan,
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
    highlightsResult = { highlights: [], citations: [], flashrank_used: false };
  }

  const ranked = highlightsResult.highlights
    .slice()
    .sort((a, b) => b.relevance_score - a.relevance_score);

  const evidence: EvidenceItem[] = [];
  let usedTokens = 0;
  for (const h of ranked) {
    if (usedTokens >= maxTokensOut) break;
    const remaining = maxTokensOut - usedTokens;
    const excerpt = truncateByTokens(h.text, remaining);
    if (!excerpt) continue;
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
