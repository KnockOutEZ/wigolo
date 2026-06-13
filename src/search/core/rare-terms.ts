// Structural rare/compound-term detection + a multiplicative rank factor.
// No lexicon: compound tokens are recognised by shape (hyphenated, digit-
// suffixed, snake_case) and are high-IDF by construction. A doc that contains
// such a token verbatim is almost certainly on-topic; a doc that contains NONE
// of the query's compounds is generic filler (the sqlite.org-homepage case).
// Multi-word concept queries are scored by the longest in-order run of query
// content-tokens present in the doc (Reciprocal-Rank-Fusion vs "Reciprocal").

export interface RareTerms {
  compoundTokens: string[];
  conceptPhrase: string[] | null;
}

export interface RareScorable {
  title: string;
  url: string;
  snippet: string;
}

// Conservative, fixture-tuned. Factor stays bounded so it shapes order without
// saturating to 0/∞ and drowning the RRF/authority/lexical signals.
const COMPOUND_PRESENT_BOOST = 0.6; // up to *1.6 (clamp) when all compounds present
const COMPOUND_ABSENT_DAMP = 0.5; // *0.5 when query has compounds but doc has none
// Strong present/absent swing (3.2x) so an exact compound match dominates
// domain-quality / authority noise — compound presence is the highest-signal
// evidence we have that a page is on-topic.
const PHRASE_BOOST = 0.4; // up to *1.4 at full-phrase contiguity
const FACTOR_MIN = 0.5;
const FACTOR_MAX = 1.6;

// Hard caps so an abusive/malformed client can't drive the per-result
// longestRun (O(phrase·doc)) or the buildRareTermVariant regex-compile loop
// with a pathologically long query — the `query` schema has no maxLength.
// Real queries carry a handful of rare terms; beyond these caps adds no signal.
const MAX_COMPOUND_TOKENS = 16;
const MAX_PHRASE_TOKENS = 32;

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'how', 'why', 'what', 'when',
  'where', 'who', 'do', 'does', 'did', 'for', 'of', 'to', 'in', 'on', 'with',
  'and', 'or', 'as', 'at', 'by', 'from', 'into', 'about', 'than', 'vs', 'using',
]);

function stripEdges(token: string): string {
  return token.replace(/^[^a-z0-9]+/i, '').replace(/[^a-z0-9]+$/i, '');
}

function classifyCompound(raw: string): string | null {
  const t = stripEdges(raw).toLowerCase();
  if (t.length < 3) return null;
  const hasAlpha = /[a-z]/.test(t);
  if (!hasAlpha) return null; // excludes "2026-06-12"
  const hyphen = /^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(t);
  const snake = /^[a-z0-9]+(?:_[a-z0-9]+)+$/.test(t);
  const digitSuffix = /^[a-z]{2,}\d+$/.test(t); // "vec0","fts5"; excludes "v18"
  return hyphen || snake || digitSuffix ? t : null;
}

function contentTokens(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map(stripEdges)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

export function detectRareTerms(query: string): RareTerms {
  if (typeof query !== 'string' || query.trim() === '') {
    return { compoundTokens: [], conceptPhrase: null };
  }
  const rawTokens = query.trim().split(/\s+/);
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

function tokenizeDoc(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(/\s+/).filter(Boolean);
}

// Longest contiguous run of `phrase` tokens (in their query order) that appears
// contiguously in `doc`.
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

// True when a result is a rare-term MISS: the query carries rare terms but this
// result contains none of them (no compound token present, or phrase run < 2).
// Used to cap domain authority per-result — a high-authority page that doesn't
// actually contain the rare terms shouldn't outrank an exact-match page. Hits
// (e.g. a result that DOES contain the compound) keep their authority intact, so
// a legitimate on-topic high-authority page is never penalised.
export function isRareTermMiss(result: RareScorable, rare: RareTerms): boolean {
  if (rare.compoundTokens.length > 0) {
    const haystack = `${result.title} ${result.url} ${result.snippet}`.toLowerCase();
    return !rare.compoundTokens.some((t) => haystack.includes(t));
  }
  if (rare.conceptPhrase && rare.conceptPhrase.length >= 2) {
    const docTokens = tokenizeDoc(`${result.title} ${result.snippet}`);
    return longestRun(rare.conceptPhrase, docTokens) < 2;
  }
  return false;
}

export function rareTermFactor(result: RareScorable, rare: RareTerms): number {
  if (rare.compoundTokens.length === 0 && !rare.conceptPhrase) return 1;

  let factor = 1;
  const haystack = `${result.title} ${result.url} ${result.snippet}`.toLowerCase();

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
