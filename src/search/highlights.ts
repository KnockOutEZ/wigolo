import type { SearchResultItem, Citation, Highlight } from '../types.js';
import { onnxRerank } from './reranker/onnx.js';
import { getConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { parseHeadings, lineStartCharOffsets } from '../extraction/markdown.js';

const log = createLogger('search');

const MAX_PASSAGE_LENGTH = 500;
const MIN_PASSAGE_LENGTH = 50;
const DEFAULT_MAX_HIGHLIGHTS = 10;

export interface HighlightSynthesisResult {
  highlights: Highlight[];
  citations: Citation[];
  reranker_used: boolean;
}

export interface Passage {
  text: string;
  charStart: number;
  charEnd: number;
}

interface PassageCandidate {
  text: string;
  sourceIndex: number;
  sourceUrl: string;
  sourceTitle: string;
  charStart: number;
  charEnd: number;
  sectionHeading: string | null;
}

function shouldKeep(trimmed: string): boolean {
  if (trimmed.length < MIN_PASSAGE_LENGTH) return false;
  if (trimmed.startsWith('#')) return false;
  if (trimmed.startsWith('|')) return false;
  if (trimmed.startsWith('```')) return false;
  if (trimmed.startsWith('- ') && trimmed.length <= 120) return false;
  return true;
}

// Walk the source markdown block-by-block (separated by blank lines) tracking
// char offsets so each surviving passage carries an accurate {charStart,
// charEnd} range pointing back into the original markdown.
export function splitIntoPassages(markdown: string): Passage[] {
  if (!markdown) return [];
  const out: Passage[] = [];
  const re = /\n\n+/g;
  let blockStart = 0;
  let m: RegExpExecArray | null;
  const consider = (rawStart: number, rawEnd: number) => {
    // raw block is markdown.slice(rawStart, rawEnd); compute trimmed range.
    const raw = markdown.slice(rawStart, rawEnd);
    if (!raw) return;
    let leading = 0;
    while (leading < raw.length && /\s/.test(raw[leading])) leading++;
    let trailing = raw.length;
    while (trailing > leading && /\s/.test(raw[trailing - 1])) trailing--;
    if (trailing <= leading) return;
    const trimmedStart = rawStart + leading;
    const trimmedEnd = rawStart + trailing;
    const trimmed = markdown.slice(trimmedStart, trimmedEnd);
    if (!shouldKeep(trimmed)) return;
    const text = trimmed.length > MAX_PASSAGE_LENGTH ? trimmed.slice(0, MAX_PASSAGE_LENGTH) : trimmed;
    const charEnd = trimmedStart + text.length;
    out.push({ text, charStart: trimmedStart, charEnd });
  };
  while ((m = re.exec(markdown)) !== null) {
    consider(blockStart, m.index);
    blockStart = m.index + m[0].length;
  }
  consider(blockStart, markdown.length);
  return out;
}

// Internal helper preserved for callers that only need the text strings.
function splitIntoPassageStrings(markdown: string): string[] {
  return splitIntoPassages(markdown).map((p) => p.text);
}

export interface AnnotatedPassage extends Passage {
  sectionHeading: string | null;
}

// Annotate each passage with the nearest preceding markdown heading. Uses
// `parseHeadings` and a char-offset prefix sum so the lookup is O(passages
// * headings) without re-parsing markdown for every passage.
export function mapPassageHeadings(
  markdown: string,
  passages: Passage[],
): AnnotatedPassage[] {
  const lines = markdown.split('\n');
  const headings = parseHeadings(lines);
  const offsets = lineStartCharOffsets(lines);
  const headingOffsets = headings.map((h) => ({ text: h.text, charStart: offsets[h.lineIndex] }));
  return passages.map((p) => {
    let nearest: string | null = null;
    for (const h of headingOffsets) {
      if (h.charStart <= p.charStart) nearest = h.text;
      else break;
    }
    return { ...p, sectionHeading: nearest };
  });
}

// Score passages across all results and return the top N using the in-process
// ONNX reranker, with a graceful first-paragraph fallback when reranking is
// disabled or fails. Each Highlight carries a source_index suitable for citing.
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
    const annotated = mapPassageHeadings(source, passages);
    for (const p of annotated) {
      candidates.push({
        text: p.text,
        sourceIndex: i + 1,
        sourceUrl: r.url,
        sourceTitle: r.title,
        charStart: p.charStart,
        charEnd: p.charEnd,
        sectionHeading: p.sectionHeading,
      });
    }
  }

  if (candidates.length === 0) {
    return {
      highlights: fallbackHighlights(results, maxHighlights),
      citations,
      reranker_used: false,
    };
  }

  const cfg = getConfig();
  if (cfg.reranker === 'onnx') {
    try {
      const scored = await onnxRerank(
        query,
        candidates.map((c) => ({ text: c.text })),
        { modelId: cfg.rerankerModel },
      );
      if (scored.length > 0) {
        const ranked = scored.slice(0, maxHighlights);
        const highlights = ranked.map<Highlight>((s) => {
          const cand = candidates[s.index];
          return {
            text: cand.text,
            source_index: cand.sourceIndex,
            relevance_score: s.score,
            source_url: cand.sourceUrl,
            source_title: cand.sourceTitle,
            section_heading: cand.sectionHeading,
            source_span: { start: cand.charStart, end: cand.charEnd },
          };
        });
        return { highlights, citations, reranker_used: true };
      }
    } catch (err) {
      log.debug('onnx reranker failed, using fallback passages', { error: String(err) });
    }
  }

  return { highlights: fallbackHighlights(results, maxHighlights), citations, reranker_used: false };
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
    const source = r.markdown_content ?? '';
    const passages = source ? splitIntoPassages(source) : [];
    if (passages.length > 0) {
      const annotated = mapPassageHeadings(source, [passages[0]])[0];
      const text = annotated.text.slice(0, MAX_PASSAGE_LENGTH);
      out.push({
        text,
        source_index: i + 1,
        relevance_score: r.relevance_score,
        source_url: r.url,
        source_title: r.title,
        section_heading: annotated.sectionHeading,
        source_span: { start: annotated.charStart, end: annotated.charStart + text.length },
      });
      continue;
    }
    const snippet = r.snippet ?? '';
    if (!snippet) continue;
    const text = snippet.slice(0, MAX_PASSAGE_LENGTH);
    out.push({
      text,
      source_index: i + 1,
      relevance_score: r.relevance_score,
      source_url: r.url,
      source_title: r.title,
      section_heading: null,
      source_span: { start: 0, end: text.length },
    });
  }
  return out;
}
