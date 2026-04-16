import type { SearchResultItem, Citation, Highlight } from '../types.js';
import { flashRankRerank, isFlashRankAvailable } from './flashrank.js';
import { createLogger } from '../logger.js';

const log = createLogger('search');

const MAX_PASSAGE_LENGTH = 500;
const MIN_PASSAGE_LENGTH = 50;
const DEFAULT_MAX_HIGHLIGHTS = 10;

export interface HighlightSynthesisResult {
  highlights: Highlight[];
  citations: Citation[];
  flashrank_used: boolean;
}

interface PassageCandidate {
  text: string;
  sourceIndex: number;
  sourceUrl: string;
  sourceTitle: string;
}

// Split a single source's markdown into candidate passages for scoring.
// Filters out headings, table rows, code fences, and short fragments so
// that scored passages are readable prose.
export function splitIntoPassages(markdown: string): string[] {
  if (!markdown) return [];
  return markdown
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length >= MIN_PASSAGE_LENGTH)
    .filter((p) => !p.startsWith('#'))
    .filter((p) => !p.startsWith('|'))
    .filter((p) => !p.startsWith('```'))
    .filter((p) => !p.startsWith('- ') || p.length > 120)
    .map((p) => (p.length > MAX_PASSAGE_LENGTH ? p.slice(0, MAX_PASSAGE_LENGTH) : p));
}

// Score passages across all results and return the top N, FlashRank-first
// with a graceful first-paragraph fallback when the Python binding is
// unavailable. Each Highlight carries a source_index suitable for citing.
export async function extractHighlights(
  query: string,
  results: SearchResultItem[],
  maxHighlights: number = DEFAULT_MAX_HIGHLIGHTS,
): Promise<HighlightSynthesisResult> {
  const citations: Citation[] = [];
  const candidates: PassageCandidate[] = [];

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    citations.push({
      index: i + 1,
      url: r.url,
      title: r.title,
      snippet: r.snippet,
    });

    const source = r.markdown_content ?? r.snippet ?? '';
    const passages = splitIntoPassages(source);
    for (const text of passages) {
      candidates.push({
        text,
        sourceIndex: i + 1,
        sourceUrl: r.url,
        sourceTitle: r.title,
      });
    }
  }

  if (candidates.length === 0) {
    // No passages survived the min-length filter (common with snippets-only
    // results). Fall back to snippet-level highlights so host LLMs still get
    // structured evidence rather than an empty array.
    return {
      highlights: fallbackHighlights(results, maxHighlights),
      citations,
      flashrank_used: false,
    };
  }

  const available = await isFlashRankAvailable();
  if (available) {
    const scored = await flashRankRerank(
      query,
      candidates.map((c, idx) => ({ text: c.text, index: idx })),
    );
    if (scored && scored.length > 0) {
      const ranked = scored
        .slice()
        .sort((a, b) => b.score - a.score)
        .slice(0, maxHighlights);
      const highlights = ranked.map<Highlight>((r) => {
        const cand = candidates[r.index];
        return {
          text: cand.text,
          source_index: cand.sourceIndex,
          relevance_score: r.score,
          source_url: cand.sourceUrl,
          source_title: cand.sourceTitle,
        };
      });
      return { highlights, citations, flashrank_used: true };
    }
    log.debug('flashrank returned null, using fallback passages');
  }

  return { highlights: fallbackHighlights(results, maxHighlights), citations, flashrank_used: false };
}

// Fallback when FlashRank is unavailable: take the first substantive paragraph
// from each source (ordered by engine relevance). Preserves citation indices
// so host LLMs can still cite [N] correctly.
export function fallbackHighlights(
  results: SearchResultItem[],
  maxHighlights: number,
): Highlight[] {
  const out: Highlight[] = [];
  for (let i = 0; i < results.length && out.length < maxHighlights; i++) {
    const r = results[i];
    const source = r.markdown_content ?? r.snippet ?? '';
    const firstPara = splitIntoPassages(source)[0] ?? r.snippet ?? '';
    if (!firstPara) continue;
    out.push({
      text: firstPara.slice(0, MAX_PASSAGE_LENGTH),
      source_index: i + 1,
      relevance_score: r.relevance_score,
      source_url: r.url,
      source_title: r.title,
    });
  }
  return out;
}
