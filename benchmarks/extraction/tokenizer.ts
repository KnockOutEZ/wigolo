import { createLogger } from '../../src/logger.js';

const log = createLogger('extract');

const MARKDOWN_UNWRAP_PATTERNS: RegExp[] = [
  /\*\*([^*]+)\*\*/g,        // bold → content
  /\*([^*]+)\*/g,            // italic → content
  /__([^_]+)__/g,            // bold alt → content
  /_([^_]+)_/g,              // italic alt → content
  /`([^`]+)`/g,              // inline code → content
  /\[([^\]]*)\]\([^)]*\)/g,  // links → text
  /!\[([^\]]*)\]\([^)]*\)/g, // images → alt text
];

const MARKDOWN_REMOVE_PATTERNS: RegExp[] = [
  /^#{1,6}\s+/gm,            // heading markers
  /^[-*+]\s+/gm,             // list markers
  /^\d+\.\s+/gm,             // numbered list markers
  /^>\s+/gm,                 // blockquote markers
  /^---+$/gm,                // horizontal rules
  /```[\s\S]*?```/g,         // fenced code blocks
];

export function normalizeText(text: string): string {
  try {
    if (!text || typeof text !== 'string') return '';

    let normalized = text;

    for (const pattern of MARKDOWN_UNWRAP_PATTERNS) {
      normalized = normalized.replace(pattern, '$1 ');
    }
    for (const pattern of MARKDOWN_REMOVE_PATTERNS) {
      normalized = normalized.replace(pattern, '');
    }

    // Collapse all whitespace (including unicode) to single spaces
    normalized = normalized.replace(/[\s\u00a0\u2000-\u200b\u2028\u2029\u202f\u205f\u3000]+/g, ' ');

    return normalized.toLowerCase().trim();
  } catch (err) {
    log.warn('normalizeText failed', { error: String(err) });
    return '';
  }
}

export function tokenize(text: string): string[] {
  try {
    if (!text || typeof text !== 'string') return [];

    const normalized = normalizeText(text);
    if (normalized.length === 0) return [];

    // Split on non-alphanumeric boundaries, filter empties
    return normalized
      .split(/[^a-z0-9]+/)
      .filter(t => t.length > 0);
  } catch (err) {
    log.warn('tokenize failed', { error: String(err) });
    return [];
  }
}

export function computeNGrams(tokens: string[], n: number): string[] {
  try {
    if (!tokens || tokens.length < n || n < 1) return [];

    const ngrams: string[] = [];
    for (let i = 0; i <= tokens.length - n; i++) {
      ngrams.push(tokens.slice(i, i + n).join(' '));
    }
    return ngrams;
  } catch (err) {
    log.warn('computeNGrams failed', { error: String(err) });
    return [];
  }
}

export function longestCommonSubsequence(a: string[], b: string[]): number {
  try {
    if (!a || !b || a.length === 0 || b.length === 0) return 0;

    // Space-optimized LCS using two rows
    const m = a.length;
    const n = b.length;
    let prev = new Array<number>(n + 1).fill(0);
    let curr = new Array<number>(n + 1).fill(0);

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (a[i - 1] === b[j - 1]) {
          curr[j] = prev[j - 1] + 1;
        } else {
          curr[j] = Math.max(prev[j], curr[j - 1]);
        }
      }
      [prev, curr] = [curr, prev];
      curr.fill(0);
    }

    return prev[n];
  } catch (err) {
    log.warn('longestCommonSubsequence failed', { error: String(err) });
    return 0;
  }
}

export interface TokenOverlapResult {
  precision: number;
  recall: number;
}

export function tokenOverlap(extracted: string[], golden: string[]): TokenOverlapResult {
  try {
    if (!extracted || !golden || extracted.length === 0 || golden.length === 0) {
      return { precision: 0, recall: 0 };
    }

    const goldenSet = new Set(golden);
    const extractedSet = new Set(extracted);

    let matchCount = 0;
    for (const token of extractedSet) {
      if (goldenSet.has(token)) matchCount++;
    }

    const precision = matchCount / extractedSet.size;
    const recall = matchCount / goldenSet.size;

    return { precision, recall };
  } catch (err) {
    log.warn('tokenOverlap failed', { error: String(err) });
    return { precision: 0, recall: 0 };
  }
}
