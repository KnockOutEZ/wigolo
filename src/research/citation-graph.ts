import type { CitationGraphEntry } from '../types.js';

export type { CitationGraphEntry };

export interface CitationGraphSource {
  url: string;
  title: string;
  markdown: string;
}

const MAX_ENTRIES = 50;
const MAX_SOURCES_PER_CLAIM = 3;
const JACCARD_THRESHOLD = 0.2;
const MIN_SENTENCE_LEN = 10;
const MIN_TOKEN_LEN = 4;

const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'and', 'or', 'but', 'in', 'on',
  'at', 'to', 'for', 'of', 'with', 'by', 'from', 'as', 'that', 'this', 'it',
  'its', 'be', 'been', 'has', 'have', 'had',
]);

export function buildCitationGraph(
  synthesisText: string,
  sources: CitationGraphSource[],
): CitationGraphEntry[] {
  if (!synthesisText || synthesisText.trim().length === 0) return [];

  // Do not treat '.' flanked by digits (e.g. $62.3) as a sentence boundary.
  // Abbreviations ("e.g.", "U.S.") remain a known limitation of this splitter.
  const sentenceMatches = synthesisText.match(
    /(?:[^.!?]|(?<=\d)\.(?=\d))+[.!?]+(?:\s|$)/g,
  );
  const sentences = sentenceMatches && sentenceMatches.length > 0
    ? sentenceMatches.map((s) => s.trim())
    : [synthesisText.trim()];

  const sourceTokens = sources.map((s) => tokenize(s.markdown));
  const entries: CitationGraphEntry[] = [];

  for (const sentence of sentences) {
    if (entries.length >= MAX_ENTRIES) break;
    if (sentence.length < MIN_SENTENCE_LEN) continue;

    const markerIndices = extractMarkers(sentence, sources.length);
    if (markerIndices.length > 0) {
      entries.push({
        claim: sentence,
        source_indices: markerIndices,
        confidence: 'high',
      });
      continue;
    }

    // No (valid) markers -> Jaccard overlap
    const sentenceTokens = tokenize(sentence);
    if (sentenceTokens.size === 0 || sourceTokens.length === 0) {
      entries.push({ claim: sentence, source_indices: [], confidence: 'low' });
      continue;
    }

    const scored: { idx: number; score: number }[] = [];
    for (let i = 0; i < sourceTokens.length; i++) {
      const score = jaccard(sentenceTokens, sourceTokens[i]);
      if (score >= JACCARD_THRESHOLD) scored.push({ idx: i, score });
    }
    scored.sort((a, b) => b.score - a.score);

    if (scored.length === 0) {
      entries.push({ claim: sentence, source_indices: [], confidence: 'low' });
    } else {
      entries.push({
        claim: sentence,
        source_indices: scored.slice(0, MAX_SOURCES_PER_CLAIM).map((s) => s.idx),
        confidence: 'medium',
      });
    }
  }

  return entries;
}

function extractMarkers(sentence: string, sourceCount: number): number[] {
  const matches = sentence.match(/\[(\d+)\]/g);
  if (!matches) return [];
  const indices: number[] = [];
  const seen = new Set<number>();
  for (const m of matches) {
    const n = Number(m.slice(1, -1));
    if (!Number.isFinite(n) || n < 1) continue;
    const idx = n - 1;
    if (idx >= sourceCount) continue;
    if (seen.has(idx)) continue;
    seen.add(idx);
    indices.push(idx);
  }
  return indices;
}

function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/);
  for (const w of words) {
    if (w.length < MIN_TOKEN_LEN) continue;
    if (STOPWORDS.has(w)) continue;
    tokens.add(w);
  }
  return tokens;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
