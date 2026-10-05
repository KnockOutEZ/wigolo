// Structural rare/compound-term detection + a multiplicative rank factor.
// Unicode-aware so Arabic and mixed-language queries get the same protections
// as Latin queries.

import { SEARCH_STOPWORDS, normalizeSearchText, tokenizeSearchText } from './text-normalization.js';

export interface RareTerms {
  compoundTokens: string[];
  conceptPhrase: string[] | null;
}

export interface RareScorable {
  title: string;
  url: string;
  snippet: string;
}

const COMPOUND_PRESENT_BOOST = 0.6;
const COMPOUND_ABSENT_DAMP = 0.5;
const PHRASE_BOOST = 0.4;
const FACTOR_MIN = 0.5;
const FACTOR_MAX = 1.6;
const MAX_COMPOUND_TOKENS = 16;
const MAX_PHRASE_TOKENS = 32;

/** Internal search helper: stripEdges. */
function stripEdges(token: string): string {
  return token.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N}]+$/u, '');
}

/** Internal search helper: classifyCompound. */
function classifyCompound(raw: string): string | null {
  const t = stripEdges(normalizeSearchText(raw));
  if (t.length < 3) return null;
  const hasAlpha = /\p{L}/u.test(t);
  if (!hasAlpha) return null;

  // A compound must retain an explicit structural separator or a letter+digit
  // suffix. Unicode letters are supported, while bare dates remain excluded.
  const hyphen = /^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)+$/u.test(t);
  const snake = /^[\p{L}\p{N}]+(?:_[\p{L}\p{N}]+)+$/u.test(t);
  const digitSuffix = /^\p{L}{2,}\d+$/u.test(t);
  return hyphen || snake || digitSuffix ? t : null;
}

/** Internal search helper: contentTokens. */
function contentTokens(query: string): string[] {
  return tokenizeSearchText(query)
    .map(stripEdges)
    .filter((t) => t.length >= 2 && /\p{L}/u.test(t) && !SEARCH_STOPWORDS.has(t));
}

/** Internal search helper: detectRareTerms. */
export function detectRareTerms(query: string): RareTerms {
  if (typeof query !== 'string' || query.trim() === '') {
    return { compoundTokens: [], conceptPhrase: null };
  }
  const rawTokens = query.trim().split(/\s+/u);
  const compoundSet = new Set<string>();
  for (const raw of rawTokens) {
    const c = classifyCompound(raw);
    if (c) compoundSet.add(c);
  }
  const compoundTokens = [...compoundSet].slice(0, MAX_COMPOUND_TOKENS);

  let conceptPhrase: string[] | null = null;
  if (compoundTokens.length === 0) {
    const content = contentTokens(query);
    if (content.length >= 2) conceptPhrase = content.slice(0, MAX_PHRASE_TOKENS);
  }
  return { compoundTokens, conceptPhrase };
}

/** Internal search helper: tokenizeDoc. */
function tokenizeDoc(s: string): string[] {
  return contentTokens(s);
}

/** Internal search helper: longestRun. */
function longestRun(phrase: string[], doc: string[]): number {
  let best = 0;
  for (let i = 0; i < phrase.length; i++) {
    for (let j = 0; j < doc.length; j++) {
      let k = 0;
      while (i + k < phrase.length && j + k < doc.length && phrase[i + k] === doc[j + k]) k++;
      if (k > best) best = k;
    }
  }
  return best;
}

/** Internal search helper: isRareTermMiss. */
export function isRareTermMiss(result: RareScorable, rare: RareTerms): boolean {
  if (rare.compoundTokens.length > 0) {
    const haystack = normalizeSearchText(
      `${result.title} ${result.url} ${result.snippet}`,
    );
    return !rare.compoundTokens.some((t) => haystack.includes(t));
  }
  if (rare.conceptPhrase && rare.conceptPhrase.length >= 2) {
    const docTokens = tokenizeDoc(`${result.title} ${result.snippet}`);
    return longestRun(rare.conceptPhrase, docTokens) < 2;
  }
  return false;
}

/** Internal search helper: rareTermFactor. */
export function rareTermFactor(result: RareScorable, rare: RareTerms): number {
  if (rare.compoundTokens.length === 0 && !rare.conceptPhrase) return 1;

  let factor = 1;
  const haystack = normalizeSearchText(
    `${result.title} ${result.url} ${result.snippet}`,
  );

  if (rare.compoundTokens.length > 0) {
    const present = rare.compoundTokens.filter((t) => haystack.includes(t));
    if (present.length > 0) {
      factor *= 1 + COMPOUND_PRESENT_BOOST * (present.length / rare.compoundTokens.length);
    } else {
      factor *= COMPOUND_ABSENT_DAMP;
    }
  }

  if (rare.conceptPhrase && rare.conceptPhrase.length >= 2) {
    const docTokens = tokenizeDoc(`${result.title} ${result.snippet}`);
    const run = longestRun(rare.conceptPhrase, docTokens);
    if (run >= 2) {
      factor *= 1 + PHRASE_BOOST * ((run - 1) / (rare.conceptPhrase.length - 1));
    }
  }

  return Math.min(FACTOR_MAX, Math.max(FACTOR_MIN, factor));
}
