import { COMMON_NOUNS } from '../hybrid/common-nouns.js';

export interface BrandCollisionWarning {
  detected: true;
  reason: string;
  brand_domains_in_top_3: string[];
  suggested_rewrites: string[];
}

const BRAND_TLD_RE = /\.(?:co\.uk|shop|store|deals|sale|boutique|fashion|com\.au|co\.nz)$/i;

// Popular dev terms whose phonetic/lexical neighbours often pull a search
// into the wrong intent space. One example pair is
// "Us statehood" ↔ "useState". Each entry is the high-traffic dev term;
// the warning fires whenever the user's 1-token query equals an entry
// (case-insensitive) or differs by <= 1 character (handles camelCase /
// runtogether typos like "usestate", "use State", "useStat").
//
// Kept small + curated — we want precision (a warning that's actually
// useful) over recall. Adding noise here would re-introduce the old
// false-positive problem.
const DEV_TERM_COLLISION_LEXICON = new Set([
  'usestate', 'useeffect', 'usememo', 'usereducer', 'usecallback', 'useref',
  'usecontext', 'usestore',
  'next', 'core', 'apple', 'mint', // these are also in the domain-collision path
  'redux', 'mobx', 'jotai', 'zustand',
  'webpack', 'babel', 'rollup', 'vite',
  'prisma', 'drizzle', 'kysely',
  'docker', 'kubernetes', 'helm',
]);

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function looksBrandy(host: string): boolean {
  return BRAND_TLD_RE.test(host);
}

function isBrandCollisionProne(query: string): boolean {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || tokens.length > 2) return false;
  return tokens.every((t) => COMMON_NOUNS.has(t.toLowerCase()));
}

function suggestRewrites(query: string): string[] {
  const q = query.trim();
  const lower = q.toLowerCase();
  // Curated rewrites for the highest-traffic collision tokens. The general
  // fallback below handles every other common noun.
  if (lower === 'next') {
    return ['Next.js framework', 'next-router library', 'JavaScript "next" framework'];
  }
  if (lower === 'core') {
    return ['.NET Core', 'wigolo core search', '"core" library'];
  }
  if (lower === 'apple') {
    return ['Apple Inc.', 'apple programming language', 'apple fruit'];
  }
  if (lower === 'mint') {
    return ['Linux Mint OS', 'mint.com finance', 'mint programming'];
  }
  // Generic disambiguation suggestions.
  return [
    `${q} framework`,
    `${q} programming`,
    `"${q}" library documentation`,
  ];
}

/**
 * Detect a brand-collision condition: the query is a common-noun token that
 * commonly clashes with a brand domain AND the top-3 results actually contain
 * a brand-domain host. Emits a structured warning with disambiguation
 * suggestions; returns null when no collision is detected.
 */
export function detectBrandCollision(
  query: string,
  topUrls: string[],
): BrandCollisionWarning | null {
  if (!isBrandCollisionProne(query)) return null;
  const top3 = topUrls.slice(0, 3);
  const brandy: string[] = [];
  for (const url of top3) {
    const host = hostOf(url);
    if (!host) continue;
    if (looksBrandy(host)) brandy.push(host);
  }
  if (brandy.length === 0) return null;
  return {
    detected: true,
    reason: `query "${query.trim()}" is a common noun that also matches brand domain(s) in the top-3`,
    brand_domains_in_top_3: brandy,
    suggested_rewrites: suggestRewrites(query),
  };
}

// Cheap normalised-edit-distance bounded at maxDist+1. Caller only cares
// whether the distance is <= maxDist; abort early once the dp row min
// exceeds the budget. Avoids the full O(m*n) when most queries are far
// from the lexicon.
function withinEditDistance(a: string, b: string, maxDist: number): boolean {
  if (Math.abs(a.length - b.length) > maxDist) return false;
  const m = a.length;
  const n = b.length;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + cost,
      );
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > maxDist) return false;
    [prev, curr] = [curr, prev];
  }
  return prev[n] <= maxDist;
}

/**
 * Lexical-collision detector. Fires when the (1-token,
 * normalised) query is identical or near-identical to a popular dev term
 * — e.g. the "useState" case. Does not require a brand domain in the
 * top-3, since the collision is purely phonetic/lexical: the user may have
 * mistyped or downcased the term and gotten generic prose back instead of
 * the framework hit.
 *
 * Suggests rewrites that anchor the intent ("useState React hook", etc.)
 * so the caller can re-query with a clearer phrase. Returns null when the
 * query is not collision-prone or doesn't match any lexicon entry.
 */
export function detectLexicalCollision(query: string): BrandCollisionWarning | null {
  const trimmed = query.trim();
  if (!trimmed) return null;
  // Single-token guard — multi-word queries usually disambiguate themselves.
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length !== 1) return null;
  const candidate = tokens[0].toLowerCase().replace(/[^a-z0-9]/g, '');
  if (candidate.length < 4 || candidate.length > 24) return null;

  let matchedTerm: string | null = null;
  for (const term of DEV_TERM_COLLISION_LEXICON) {
    if (term === candidate) {
      matchedTerm = term;
      break;
    }
    // Allow a single edit for short typos; longer terms get one error
    // budget per ~8 chars (capped at 2) — keeps "us state" out while
    // accepting "usestaste".
    const budget = Math.min(2, Math.floor(term.length / 8) + 1);
    if (withinEditDistance(candidate, term, budget)) {
      matchedTerm = term;
      break;
    }
  }
  if (!matchedTerm) return null;

  return {
    detected: true,
    reason: `query "${trimmed}" is lexically close to "${matchedTerm}" — a popular dev term; results may be drawn from the unrelated meaning space`,
    brand_domains_in_top_3: [],
    suggested_rewrites: [
      `${matchedTerm} React hook`,
      `"${matchedTerm}" documentation`,
      `${matchedTerm} api reference`,
    ],
  };
}
