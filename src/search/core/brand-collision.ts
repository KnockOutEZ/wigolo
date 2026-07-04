import { COMMON_NOUNS } from '../hybrid/common-nouns.js';
import { extractEntities } from './query-understanding.js';
import { queryHasErrorToken } from './intent-router.js';

export interface BrandCollisionWarning {
  detected: true;
  reason: string;
  brand_domains_in_top_3: string[];
  suggested_rewrites: string[];
}

// Generic category / qualifier nouns that follow an entity head in an
// ambiguous "Entity + generic tail" query (e.g. "Phoenix framework",
// "Apollo documentation", "Comet ML experiment tracking"). These are the
// everyday category words that DON'T disambiguate the entity — they signal a
// caller who typed a proper-noun product/company name plus a topic, which is
// exactly the collision case. Pattern-level: category words, never entity
// names, so the detector never depends on a benchmark allowlist.
const GENERIC_TAIL_NOUNS: ReadonlySet<string> = new Set([
  'framework', 'library', 'documentation', 'docs', 'api', 'sdk', 'cli',
  'pricing', 'price', 'cost', 'plan', 'plans', 'tier', 'tiers',
  'deployment', 'deploy', 'hosting', 'install', 'installation', 'setup',
  'config', 'configuration', 'guide', 'tutorial', 'reference', 'manual',
  'dashboard', 'console', 'account', 'login', 'signup', 'auth',
  'app', 'service', 'platform', 'tool', 'client', 'server', 'agent',
  'banking', 'bank', 'card', 'payment', 'payments', 'transfer', 'transport',
  'tracking', 'analytics', 'metrics', 'monitoring', 'logging',
  'experiment', 'experiments', 'dataset', 'model', 'training',
  'limits', 'limit', 'quota', 'rate', 'usage', 'billing',
  'database', 'db', 'storage', 'cache', 'queue', 'stream',
  'network', 'proxy', 'gateway', 'router', 'firewall', 'vpn',
  'support', 'status', 'health', 'uptime', 'release', 'changelog',
]);

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

// The SUBSET of the lexicon for which the generated "<term> React hook" rewrite
// is semantically valid — the React-hook-name family. Only these may be
// AUTO-DISPATCHED (topCollisionRewrite case 2): dual-dispatching "useState
// React hook" for a downcased "usestate" query genuinely anchors the intent.
// The rest of the lexicon (library/tool/ORM names — docker, vite, prisma,
// redux, webpack, …) is WARNING-ONLY: `detectLexicalCollision` still advises on
// them (harmless when wrong), but auto-dispatching "docker React hook" would
// RRF-merge React-hooks docs into a clean tool query — actively harmful. So the
// auto-dispatch gate is this narrow set, not the whole lexicon.
const REACT_HOOK_TERMS: ReadonlySet<string> = new Set([
  'usestate', 'useeffect', 'usememo', 'usereducer', 'usecallback', 'useref',
  'usecontext', 'usestore',
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

// Sentence-frame lead words: capitalized because they open a query, NOT
// because they name an entity. A query that leads with an interrogative,
// article, possessive, superlative, or imperative verb is a question/command
// ("How to deploy Rails", "Best framework for api", "Configure nginx …"), not
// an "Entity + generic tail" collision. Pattern-level stopword/verb set, never
// entity-specific. Compared lowercase so casing of the lead doesn't matter.
const SENTENCE_FRAME_LEADS: ReadonlySet<string> = new Set([
  // interrogatives
  'how', 'what', 'why', 'when', 'where', 'which', 'who', 'whose', 'whom',
  // articles / demonstratives
  'the', 'a', 'an', 'this', 'that', 'these', 'those',
  // possessives
  'my', 'your', 'our', 'their', 'its', 'his', 'her',
  // superlatives / quantifiers
  'best', 'top', 'most', 'worst', 'least', 'some', 'any', 'all',
  // imperative / instructional verbs
  'configure', 'deploy', 'deploying', 'build', 'building', 'use', 'using',
  'setup', 'set', 'create', 'creating', 'add', 'adding', 'fix', 'fixing',
  'install', 'installing', 'run', 'running', 'get', 'getting', 'make',
  'making', 'compare', 'comparing', 'choose', 'choosing', 'understand',
  'understanding', 'learn', 'learning', 'enable', 'disable', 'update',
  'upgrade', 'migrate', 'remove', 'debug', 'test', 'write', 'find',
]);

// A token is an entity HEAD for the v2 collision path when the user typed it
// as a Capitalized-word proper noun — a product/company/place name like
// Phoenix, Apollo, Mercury, Comet, or a dotted brand like Next.js. This is a
// STRUCTURAL casing signal (`^[A-Z][a-z]`), narrower than the general entity
// extractor on purpose:
//   - a lowercase technical phrase ("react server components") never reads as
//     an entity head, so it can't false-fire;
//   - a bare ALL-CAPS acronym ("RAG tutorial", "HTTP guide") is NOT a
//     brand-collision-prone name — acronyms disambiguate themselves and drive
//     other routing (docs vertical), so they're excluded here;
//   - a capitalized SENTENCE-FRAME lead (How/Best/Configure/…) opens a
//     question or command, not an entity name — excluded via the stopword set.
function isEntityToken(token: string): boolean {
  const stripped = token.replace(/[^A-Za-z0-9.\-]/g, '');
  if (stripped.length < 2) return false;
  if (!/^[A-Z][a-z]/.test(stripped)) return false;
  if (SENTENCE_FRAME_LEADS.has(stripped.toLowerCase())) return false;
  return extractEntities(stripped).length > 0;
}

/**
 * Structural brand-collision predicate (unified — this is the single source of
 * truth; query-understanding re-exports it for its `is_brand_collision_prone`
 * field). Fires in two pattern-level cases:
 *
 *   1. Short common-noun query (<=2 tokens, every token a collision-prone
 *      common noun) — the original "next", "apple mint" case.
 *   2. Proper-noun-head + generic-tail (any token count) — the first token is
 *      an entity AND a later token is a generic category noun, e.g.
 *      "Phoenix framework deployment", "Apollo API documentation". This is the
 *      s5-class collision the old <=2-token gate could never reach.
 *
 * Never fires on an error-token query (S1 owns error intent) — an error string
 * like "TypeError undefined api" must not be treated as a brand collision.
 */
export function isBrandCollisionProne(query: string): boolean {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  if (queryHasErrorToken(query)) return false;

  // Case 1: short all-common-noun query.
  if (tokens.length <= 2 && tokens.every((t) => COMMON_NOUNS.has(t.toLowerCase()))) {
    return true;
  }

  // Case 2: proper-noun head + generic tail.
  if (tokens.length >= 2 && isEntityToken(tokens[0])) {
    for (let i = 1; i < tokens.length; i++) {
      const t = tokens[i].toLowerCase().replace(/[^a-z0-9]/g, '');
      if (GENERIC_TAIL_NOUNS.has(t)) return true;
    }
  }
  return false;
}

// True for a short ALL-CAPS acronym token (ML, AI, DB, API) that trails a
// capitalized head as part of the brand name ("Comet ML", "Vertex AI").
function isAcronymSuffix(token: string): boolean {
  const stripped = token.replace(/[^A-Za-z0-9]/g, '');
  return /^[A-Z]{2,4}$/.test(stripped);
}

// The verbatim entity head of the query. Starts with the leading capitalized
// proper-noun token, then absorbs a contiguous ALL-CAPS acronym token (ML/AI/
// DB) that is part of the brand name so a multi-token brand like "Comet ML" is
// anchored whole in the rewrite rather than split to just "Comet".
function entityHead(query: string): string {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || !isEntityToken(tokens[0])) return '';
  const head: string[] = [tokens[0]];
  for (let i = 1; i < tokens.length; i++) {
    if (isEntityToken(tokens[i]) || isAcronymSuffix(tokens[i])) head.push(tokens[i]);
    else break;
  }
  return head.join(' ');
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

/**
 * Build an entity-qualified rewrite of an "Entity + generic tail" query. The
 * entity head is quoted so an engine treats it as one atom, keeping the whole
 * original query intent while anchoring on the ambiguous entity — e.g.
 * `Phoenix framework deployment` → `"Phoenix" framework deployment`. Returns
 * null when the query carries no detectable entity head.
 */
export function entityQualifiedRewrite(query: string): string | null {
  const q = query.trim();
  const head = entityHead(q);
  if (!head) return null;
  const rest = q.slice(head.length).trim();
  const rewrite = rest ? `"${head}" ${rest}` : `"${head}"`;
  // Only useful when it actually differs from the original query.
  return rewrite !== q ? rewrite : null;
}

/**
 * Detect an entity-collision condition (brand-collision v2): a proper-noun-head
 * + generic-tail query is structurally ambiguous — the head names an entity
 * that clashes with an everyday word. Unlike detectBrandCollision this does NOT
 * require a brand TLD in the top-3, since the collision is in the query itself.
 * Emits a warning whose rewrites anchor the entity head verbatim so the caller
 * can disambiguate. Returns null when the query is not entity-collision prone.
 */
export function detectEntityCollision(query: string): BrandCollisionWarning | null {
  const q = query.trim();
  if (!q) return null;
  const tokens = q.split(/\s+/).filter(Boolean);
  // Only the v2 shape: an entity head with a generic tail. The <=2-token
  // common-noun case is handled by the domain-aware detectBrandCollision path.
  if (queryHasErrorToken(q)) return null;
  if (!(tokens.length >= 2 && isEntityToken(tokens[0]))) return null;
  const hasGenericTail = tokens
    .slice(1)
    .some((t) => GENERIC_TAIL_NOUNS.has(t.toLowerCase().replace(/[^a-z0-9]/g, '')));
  if (!hasGenericTail) return null;

  const head = entityHead(q) || tokens[0];
  const qualified = entityQualifiedRewrite(q);
  const rewrites: string[] = [];
  if (qualified) rewrites.push(qualified);
  rewrites.push(`${head} (software)`, `${head} official site`);

  return {
    detected: true,
    reason: `query "${q}" pairs the entity "${head}" with a generic term — the entity name may collide with an unrelated meaning; results may drift off-entity`,
    brand_domains_in_top_3: [],
    suggested_rewrites: rewrites,
  };
}

/**
 * The single top disambiguating rewrite for a query that is QUERY-ONLY
 * collision-prone — i.e. detectable without looking at any result URLs. Two
 * cases, both mirroring an existing detector's rewrites:
 *
 *   1. A short common-noun brand collision (`isBrandCollisionProne` case 1,
 *      e.g. "next", "apple mint") → the top of `suggestRewrites` — the same
 *      rewrites `detectBrandCollision` emits once a brand TLD is seen in the
 *      top-3. Anchored here on the query alone so it can dispatch CONCURRENTLY
 *      with the primary wave (the warning still gates on the top-3 as before).
 *   2. A single-token React-HOOK-name lexical collision (e.g. "useState") →
 *      the "<term> React hook" rewrite. Gated on the React-hook SUBSET of the
 *      lexicon (`REACT_HOOK_TERMS`), NOT the full lexicon: the "<term> React
 *      hook" rewrite is only semantically valid for hook names. Library/tool/
 *      ORM terms (docker, vite, prisma, redux, webpack, …) stay warning-only —
 *      auto-dispatching "docker React hook" would RRF-merge React-hooks docs
 *      into a clean tool query, which is actively harmful.
 *
 * Excluded on purpose (handled elsewhere or not query-only):
 *   - the proper-noun-head + generic-tail case (`detectEntityCollision`) —
 *     already auto-dispatched via `entityQualifiedRewrite`; returning null here
 *     avoids a duplicate third dispatch;
 *   - any error-token query (`isBrandCollisionProne` already rejects these).
 *
 * Returns null when the query is not query-only collision-prone or the rewrite
 * would be identical to the query.
 */
export function topCollisionRewrite(query: string): string | null {
  const q = query.trim();
  if (!q) return null;

  const tokens = q.split(/\s+/).filter(Boolean);
  // Case 1: short (<=2 token) all-common-noun brand collision. Skip the
  // proper-noun-head case — detectEntityCollision owns its dispatch.
  const shortCommonNoun =
    tokens.length <= 2 &&
    tokens.length > 0 &&
    tokens.every((t) => COMMON_NOUNS.has(t.toLowerCase())) &&
    !queryHasErrorToken(q);
  if (shortCommonNoun) {
    const rewrite = suggestRewrites(q)[0];
    if (rewrite && rewrite.trim() !== q) return rewrite;
  }

  // Case 2: single-token React-hook-name lexical collision ONLY. Restricted to
  // REACT_HOOK_TERMS so a library/tool term (docker/vite/prisma/…) — for which
  // "<term> React hook" is nonsense — is never auto-dispatched (warning-only).
  const hookTerm = matchLexiconTerm(q, REACT_HOOK_TERMS);
  if (hookTerm) {
    const rewrite = `${hookTerm} React hook`;
    if (rewrite.trim() !== q) return rewrite;
  }

  return null;
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
// Match a single-token query against a lexicon (exact or within a small typo
// budget), returning the matched lexicon term or null. Shared by the warning
// detector (full lexicon) and the auto-dispatch gate (React-hook subset) so the
// two use identical matching semantics.
function matchLexiconTerm(query: string, lexicon: ReadonlySet<string>): string | null {
  const trimmed = query.trim();
  if (!trimmed) return null;
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length !== 1) return null;
  const candidate = tokens[0].toLowerCase().replace(/[^a-z0-9]/g, '');
  if (candidate.length < 4 || candidate.length > 24) return null;

  for (const term of lexicon) {
    if (term === candidate) return term;
    // Allow a single edit for short typos; longer terms get one error
    // budget per ~8 chars (capped at 2) — keeps "us state" out while
    // accepting "usestaste".
    const budget = Math.min(2, Math.floor(term.length / 8) + 1);
    if (withinEditDistance(candidate, term, budget)) return term;
  }
  return null;
}

export function detectLexicalCollision(query: string): BrandCollisionWarning | null {
  const trimmed = query.trim();
  const matchedTerm = matchLexiconTerm(query, DEV_TERM_COLLISION_LEXICON);
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
