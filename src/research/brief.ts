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

  const topics = buildTopics(subQueries, fetched);
  const keyFindings = buildKeyFindings(fetched);
  const crossReferences = detectCrossReferences(fetched);
  const gaps: Array<string | { entity: string; reason: string }> = [
    ...detectGaps(subQueries, fetched),
    ...detectEntityGaps(question, subQueries),
  ];

  const comparison = queryType === 'comparison' && comparisonEntities.length >= 2
    ? buildComparisonSection(comparisonEntities, fetched)
    : undefined;

  // citation_graph source_indices must align with the output
  // `sources` array (0-based, full list including unfetched rows). We build
  // the graph against the `fetched` view (only documents we have content
  // for), then remap each index back into the original `sources` array so
  // a caller can index `sources[entry.source_indices[i]]` directly.
  let citationGraph: ReturnType<typeof buildCitationGraph> | undefined;
  if (synthesisText && synthesisText.trim().length > 0 && fetched.length > 0) {
    const rawGraph = buildCitationGraph(
      synthesisText,
      fetched.map((s) => ({ url: s.url, title: s.title, markdown: s.markdown_content })),
    );
    const fetchedToFullIndex = fetched.map((s) => sources.indexOf(s));
    citationGraph = rawGraph.map((entry) => ({
      ...entry,
      source_indices: entry.source_indices
        .map((idx) => fetchedToFullIndex[idx])
        .filter((idx) => idx >= 0),
    }));
  }

  return {
    topics,
    highlights,
    key_findings: keyFindings,
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
// Ordered by source relevance so the most-weighted finding is first.
function buildKeyFindings(sources: ResearchSource[]): string[] {
  const out: string[] = [];
  for (const s of [...sources].sort((a, b) => b.relevance_score - a.relevance_score)) {
    const first = firstSubstantiveParagraph(s.markdown_content);
    if (!first) continue;
    const trimmed = first.length > MAX_KEY_FINDING_LEN
      ? first.slice(0, MAX_KEY_FINDING_LEN - 1).trimEnd() + '…'
      : first;
    out.push(trimmed);
  }
  return dedupe(out);
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
    return cleaned.replace(/\s+/g, ' ');
  }
  return null;
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
