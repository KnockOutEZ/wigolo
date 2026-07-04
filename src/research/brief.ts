import type { ResearchBrief, ResearchSource, SearchResultItem, CrossReference, ComparisonTradeoff } from '../types.js';
import type { QueryType } from './decompose.js';
import { extractHighlights } from '../search/highlights.js';
import { buildCitationGraph } from './citation-graph.js';
import { detectEntityGaps } from './entity-extractor.js';

const MAX_HIGHLIGHTS = 12;
const MAX_KEY_FINDING_LEN = 280;
const MAX_TOPICS = 8;
const MAX_CROSS_REFS = 10;
const MIN_PHRASE_LEN = 4;

// Build a host-LLM-friendly structured brief when internal sampling is
// unavailable. The host model (Claude Code / Cursor / etc.) consumes this
// shape to produce the final report without needing to re-read raw sources.
export async function buildResearchBrief(
  question: string,
  sources: ResearchSource[],
  subQueries: string[],
  perSourceCharCap: number,
  totalSourcesCharCap: number,
  queryType: QueryType = 'general',
  comparisonEntities: string[] = [],
  synthesisText?: string,
): Promise<ResearchBrief> {
  const fetched = sources.filter((s) => s.fetched && s.markdown_content.length > 0);

  // Highlights reuse the ONNX-reranker-or-paragraph scorer so briefs align with
  // whatever format='highlights' produces for single-query searches.
  const searchItems: SearchResultItem[] = fetched.map((s) => ({
    title: s.title,
    url: s.url,
    snippet: s.markdown_content.slice(0, 200),
    markdown_content: s.markdown_content,
    relevance_score: s.relevance_score,
  }));

  const { highlights } = await extractHighlights(question, searchItems, MAX_HIGHLIGHTS);

  // All source-index provenance is built against the `fetched` view (only the
  // documents we have content for), but the rendered ### Sources list and every
  // emitted `[n]` index into the FULL `sources` array. Remap fetched-view
  // indices back to the full array once so a leading unfetched row can't shift
  // a citation by one. Reused for findings, cross-references, tradeoffs, and
  // the citation graph.
  const fetchedToFull = fetched.map((s) => sources.indexOf(s));

  const topics = buildTopics(subQueries, fetched);
  const keyFindingsWithSource = buildKeyFindings(fetched);
  const keyFindings = keyFindingsWithSource.map((f) => f.text);
  const keyFindingSources = keyFindingsWithSource.map(
    (f) => fetchedToFull[f.fetchedIdx],
  );

  const crossReferences = detectCrossReferences(fetched).map((ref) => ({
    ...ref,
    source_indices: ref.source_indices
      .map((idx) => fetchedToFull[idx])
      .filter((idx) => idx >= 0),
  }));

  const gaps: Array<string | { entity: string; reason: string }> = [
    ...detectGaps(subQueries, fetched),
    ...detectEntityGaps(question, subQueries),
  ];

  const rawComparison = queryType === 'comparison' && comparisonEntities.length >= 2
    ? buildComparisonSection(comparisonEntities, fetched)
    : undefined;
  const comparison = rawComparison
    ? {
        ...rawComparison,
        tradeoffs: rawComparison.tradeoffs.map((t) => ({
          ...t,
          source_index: fetchedToFull[t.source_index] ?? t.source_index,
        })),
      }
    : undefined;

  // citation_graph source_indices must align with the output `sources` array
  // (0-based, full list including unfetched rows), same as above.
  let citationGraph: ReturnType<typeof buildCitationGraph> | undefined;
  if (synthesisText && synthesisText.trim().length > 0 && fetched.length > 0) {
    const rawGraph = buildCitationGraph(
      synthesisText,
      fetched.map((s) => ({ url: s.url, title: s.title, markdown: s.markdown_content })),
    );
    citationGraph = rawGraph.map((entry) => ({
      ...entry,
      source_indices: entry.source_indices
        .map((idx) => fetchedToFull[idx])
        .filter((idx) => idx >= 0),
    }));
  }

  return {
    topics,
    highlights,
    key_findings: keyFindings,
    key_finding_sources: keyFindingSources,
    per_source_char_cap: perSourceCharCap,
    total_sources_char_cap: totalSourcesCharCap,
    sections: {
      overview: {
        key_findings: keyFindings.slice(0, 5),
        cross_references: crossReferences,
      },
      ...(comparison ? { comparison } : {}),
      gaps,
    },
    query_type: queryType,
    ...(citationGraph && citationGraph.length > 0 ? { citation_graph: citationGraph } : {}),
  };
}

// Prefer sub-queries (planner's view of the topic space) when available;
// otherwise derive compact topic labels from source titles.
function buildTopics(subQueries: string[], sources: ResearchSource[]): string[] {
  if (subQueries.length > 0) {
    return dedupe(subQueries).slice(0, MAX_TOPICS);
  }
  const labels = sources
    .map((s) => s.title.split(/[–|:·-]/)[0].trim())
    .filter((t) => t.length >= 5 && t.length <= 100);
  return dedupe(labels).slice(0, MAX_TOPICS);
}

// First substantive paragraph per source, trimmed to a finding-sized blurb.
// Ordered by source relevance so the most-weighted finding is first. Each
// finding carries the index of the source it came from WITHIN the passed-in
// (fetched) view, so the caller can attach per-claim provenance. Dedupe is
// applied to the finding text, keeping the first (highest-relevance) source
// for a repeated blurb so text and index stay aligned.
function buildKeyFindings(
  sources: ResearchSource[],
): Array<{ text: string; fetchedIdx: number }> {
  const ordered = sources
    .map((s, fetchedIdx) => ({ s, fetchedIdx }))
    .sort((a, b) => b.s.relevance_score - a.s.relevance_score);

  const out: Array<{ text: string; fetchedIdx: number }> = [];
  const seen = new Set<string>();
  for (const { s, fetchedIdx } of ordered) {
    const first = firstSubstantiveParagraph(s.markdown_content);
    if (!first) continue;
    const trimmed = first.length > MAX_KEY_FINDING_LEN
      ? first.slice(0, MAX_KEY_FINDING_LEN - 1).trimEnd() + '…'
      : first;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ text: trimmed, fetchedIdx });
  }
  return out;
}

export function detectCrossReferences(sources: ResearchSource[]): CrossReference[] {
  if (sources.length < 2) return [];

  // Extract significant phrases from each source's content
  const phraseMap = new Map<string, Set<number>>();

  for (let idx = 0; idx < sources.length; idx++) {
    const content = sources[idx].markdown_content.toLowerCase();
    const words = content
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= MIN_PHRASE_LEN && !STOP_WORDS.has(w));

    const seenForSource = new Set<string>();
    for (let i = 0; i < words.length - 2; i++) {
      const phrase = words.slice(i, i + 3).join(' ');
      if (seenForSource.has(phrase)) continue;
      seenForSource.add(phrase);

      if (!phraseMap.has(phrase)) phraseMap.set(phrase, new Set());
      phraseMap.get(phrase)!.add(idx);
    }
  }

  // Phrases found in 2+ sources are cross-references
  const candidates: CrossReference[] = [];
  for (const [phrase, sourceIndices] of phraseMap) {
    if (sourceIndices.size >= 2) {
      candidates.push({
        finding: phrase,
        source_indices: [...sourceIndices].sort(),
        confidence: sourceIndices.size >= 3 ? 'high' : 'medium',
      });
    }
  }

  // Sort by number of sources (desc), then deduplicate overlapping phrases
  candidates.sort((a, b) => b.source_indices.length - a.source_indices.length);
  return deduplicateOverlapping(candidates).slice(0, MAX_CROSS_REFS);
}

function deduplicateOverlapping(refs: CrossReference[]): CrossReference[] {
  const kept: CrossReference[] = [];
  const usedWords = new Set<string>();

  for (const ref of refs) {
    const words = ref.finding.split(' ');
    // Skip if most words already covered by a higher-ranked cross-reference
    const overlapCount = words.filter((w) => usedWords.has(w)).length;
    if (overlapCount >= words.length - 1 && kept.length > 0) continue;

    kept.push(ref);
    for (const w of words) usedWords.add(w);
  }

  return kept;
}

function detectGaps(subQueries: string[], sources: ResearchSource[]): string[] {
  if (subQueries.length === 0) return [];

  const gaps: string[] = [];
  const contentLower = sources.map((s) => s.markdown_content.toLowerCase()).join(' ');

  for (const query of subQueries) {
    // Extract significant words from sub-query
    const words = query.toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= MIN_PHRASE_LEN && !STOP_WORDS.has(w));

    if (words.length === 0) continue;

    // Count how many significant words appear in any source
    const found = words.filter((w) => contentLower.includes(w)).length;
    const coverage = found / words.length;

    if (coverage < 0.5) {
      gaps.push(`Limited coverage for: "${query}"`);
    }
  }

  return gaps;
}

const COMPARISON_TERMS = ['faster', 'slower', 'better', 'worse', 'more', 'less',
  'easier', 'harder', 'simpler', 'complex', 'lightweight', 'heavy',
  'performance', 'scalability', 'ecosystem', 'community', 'support'];

// Pre-compile the word-boundary matchers once. buildComparisonSection scans
// every sentence of every source against every term, so compiling these in the
// inner loop meant ~8500 RegExp constructions per call.
const COMPARISON_TERM_MATCHERS: Array<{ term: string; re: RegExp }> =
  COMPARISON_TERMS.map((term) => ({ term, re: new RegExp(`\\b${term}\\b`) }));

const MAX_TRADEOFFS = 8;
const MAX_TRADEOFF_LEN = 280;

// Scan each source for sentences that pair a compared entity with a comparison
// term. We keep BOTH the bare-keyword `comparison_points` (the host-LLM shape)
// AND the source-quoted `tradeoffs` (the template renderer's evidence). The
// tradeoff carries the sentence verbatim plus the index of the source it came
// from, so the renderer can quote a real, cited tradeoff without inventing
// directionality from a keyword alone.
function buildComparisonSection(
  entities: string[],
  sources: ResearchSource[],
): { entities: string[]; comparison_points: string[]; tradeoffs: ComparisonTradeoff[] } {
  const comparisonPoints = new Set<string>();
  const tradeoffs: ComparisonTradeoff[] = [];
  const seenSentences = new Set<string>();
  const entitiesLower = entities.map((e) => e.toLowerCase());

  for (let idx = 0; idx < sources.length; idx++) {
    const cleaned = stripMarkdownLinks(sources[idx].markdown_content);
    const sentences = splitSentences(cleaned);

    for (const sentence of sentences) {
      const sentenceLower = sentence.toLowerCase();
      const hasEntity = entitiesLower.some((e) => sentenceLower.includes(e));
      if (!hasEntity) continue;

      // The comparison term must appear in the same sentence as an entity —
      // that co-location is what makes the keyword a directional signal we can
      // honestly quote.
      const matchedTerms = COMPARISON_TERM_MATCHERS
        .filter((m) => m.re.test(sentenceLower))
        .map((m) => m.term);
      if (matchedTerms.length === 0) continue;

      for (const t of matchedTerms) comparisonPoints.add(t);

      const dedupeKey = sentenceLower.slice(0, 120);
      if (seenSentences.has(dedupeKey)) continue;
      seenSentences.add(dedupeKey);

      if (tradeoffs.length < MAX_TRADEOFFS) {
        const text = sentence.length > MAX_TRADEOFF_LEN
          ? sentence.slice(0, MAX_TRADEOFF_LEN - 1).trimEnd() + '…'
          : sentence;
        tradeoffs.push({ text, source_index: idx, term: matchedTerms[0] });
      }
    }
  }

  return {
    entities,
    comparison_points: [...comparisonPoints],
    tradeoffs,
  };
}

// Split prose into sentences on terminal punctuation. Keeps it simple — the
// goal is a quotable unit, not linguistic perfection. Collapses whitespace so
// a quoted tradeoff reads cleanly.
function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 20);
}

function firstSubstantiveParagraph(markdown: string): string | null {
  const paragraphs = markdown.split(/\n\n+/).map((p) => p.trim());
  for (const p of paragraphs) {
    if (p.length < 80) continue;
    if (p.startsWith('#') || p.startsWith('|') || p.startsWith('```')) continue;
    const cleaned = stripMarkdownLinks(p);
    if (cleaned.length < 80) continue;
    const normalized = cleaned.replace(/\s+/g, ' ');
    // Skip nav/byline/caption chrome so a candidate advances to the next
    // paragraph — the article body — instead of surfacing a photo-credit,
    // author byline, or breadcrumb menu as a fabricated finding. Evaluated on
    // BOTH the raw paragraph (a truncated image span never link-flattens) and
    // the normalized prose (nav labels read as plain text after flatten).
    if (isBoilerplateSpan(p, normalized)) continue;
    return normalized;
  }
  return null;
}

// Photo-credit signatures that mark a paragraph as a caption rather than the
// article body: "(AP Photo/…)", "(Getty Images)", "(Reuters)", "Photo by …",
// or a standalone "Credit:"/"Image:" attribution.
const PHOTO_CREDIT_PATTERNS: ReadonlyArray<RegExp> = [
  /\((?:AP Photo|Getty|Reuters|AFP|Bloomberg|EPA|Shutterstock)[^)]*\)/i,
  /\bphoto by [A-Z]/,
  /^(?:photo|image|credit|caption)\s*:/i,
];

// A byline is provenance chrome ("By Jane Smith … | 5 min read | Published …"),
// NOT prose. It opens with "By " + a Capitalized proper name AND carries a
// byline chrome marker (a "N min read", a Published/Updated stamp, or the
// pipe-delimited meta chain). Requiring the chrome marker is what keeps an
// ordinary sentence that merely begins with the preposition "By" (e.g. "By
// reducing the memory footprint …") from being filtered as a byline.
const BYLINE_LEAD = /^By\s+[A-Z][a-z]+(?:\s+[A-Z][a-z.]+){0,3}\b/;
const BYLINE_CHROME = /\b\d+\s+min read\b|\b(?:Published|Updated)\b|[|·]/;

// Detect a nav/menu/breadcrumb chain: short labels joined by pipes or chevrons
// with no sentence punctuation. `separators / segments` is high and the mean
// segment is short — the shape of "Home | News | Technology | …", not prose.
function isNavigationChain(text: string): boolean {
  const separators = (text.match(/[|»›>·]/g) ?? []).length;
  if (separators < 3) return false;
  if (/[.!?](?:\s|$)/.test(text)) return false;
  const segments = text.split(/\s*[|»›>·]\s*/).map((s) => s.trim()).filter(Boolean);
  if (segments.length < 4) return false;
  const longSegments = segments.filter((s) => s.split(/\s+/).length > 4).length;
  return longSegments === 0;
}

function isBoilerplateSpan(raw: string, normalized: string): boolean {
  // Caption/credit: a paragraph that opens with an image span (well-formed or
  // truncated mid-link, which never link-flattens) or carries a photo credit.
  if (/^\s*!?\[?!\[/.test(raw)) return true;
  if (PHOTO_CREDIT_PATTERNS.some((re) => re.test(normalized))) return true;
  // Author byline chrome.
  if (BYLINE_LEAD.test(normalized) && BYLINE_CHROME.test(normalized)) return true;
  // Navigation / breadcrumb menu chain.
  if (isNavigationChain(normalized)) return true;
  return false;
}

// Flatten markdown link/image syntax to plain text so a downstream char-slice
// can't chop mid-link and leak `](/?source=post_page...` into key_findings.
// Covers reference-style links (`[label][1]`), bare http(s) URLs in prose,
// and HTML <a> tags. All three shapes can leak into key_findings as link
// artifacts; the finding is meant to be prose evidence, not a pointer.
export function stripMarkdownLinks(text: string): string {
  return text
    // Markdown image: `![alt](url)`
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    // Image-wrapped-in-link: `[![alt](img)](url)`
    .replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, '')
    // Inline link: `[label](url)` → `label`
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    // Reference-style link: `[label][id]` → `label`. Must come AFTER the
    // inline replace so we don't strip the `(url)` half of a real link.
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    // HTML anchor: `<a ...>label</a>` → `label`. Greedy-safe via non-greedy
    // body match.
    .replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, '$1')
    // Auto-link: `<https://...>`
    .replace(/<https?:\/\/[^>]+>/g, '')
    // Bare http(s) URLs left over after the above. The failure
    // mode is a tracking URL pasted directly into prose; drop it.
    .replace(/https?:\/\/\S+/g, '')
    // Collapse the double-spaces a removal leaves behind so the finding
    // reads naturally instead of "X  Y".
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function dedupe(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

const STOP_WORDS = new Set([
  'about', 'after', 'also', 'been', 'before', 'being', 'between',
  'both', 'could', 'does', 'doing', 'done', 'each', 'even', 'every',
  'from', 'have', 'here', 'into', 'just', 'like', 'made', 'make',
  'many', 'more', 'most', 'much', 'must', 'need', 'only', 'other',
  'over', 'same', 'should', 'some', 'such', 'than', 'that', 'their',
  'them', 'then', 'there', 'these', 'they', 'this', 'those', 'through',
  'very', 'want', 'well', 'were', 'what', 'when', 'where', 'which',
  'while', 'will', 'with', 'would', 'your',
]);
