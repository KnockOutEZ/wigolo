// Source validation for the research pipeline. Two pure classifiers keep
// homepages, search-engine results pages, and empty content shells out of the
// brief's source list (benchmark 2026-06-12 C1 leaked a Google homepage and a
// blog-search results page). Rerank already owns relevance — the content gate
// is deliberately NOT a relevance filter; it only drops thin AND off-topic
// shells so a short on-topic doc and a long off-topic page both survive.

export type UrlShapeReason = 'homepage' | 'serp';
export type ContentGateReason = 'low-content' | 'low-overlap';
export type ScoreFloorReason = 'negative-score';

export interface UrlShapeVerdict {
  reject: boolean;
  reason?: UrlShapeReason;
}

export interface ContentGateVerdict {
  reject: boolean;
  reason?: ContentGateReason;
}

export interface ScoreFloorVerdict {
  reject: boolean;
  reason?: ScoreFloorReason;
}

// Reranker relevance threshold. A cross-encoder logit below this means the
// model judged the source NOT relevant — the same boundary the search
// rerank-fold uses for its tier-0 split. Off-topic real-content domains
// (benchmark 2026-06-14 C1: YouTube / Google Play / Zhihu / MyBroadband)
// land below zero here even though they pass the url-shape + content gates.
const SCORE_FLOOR = 0;

/**
 * Classify a candidate research source by its (post-rerank) relevance score.
 * Rejects strictly-negative scores — the cross-encoder's "not relevant"
 * verdict. Positive scores (the keyless passthrough path's engine/RRF values,
 * or a relevant cross-encoder logit) always survive, so this is a no-op when
 * no cross-encoder ran. The caller is responsible for never emptying the pool
 * (it keeps the single best source as a floor of last resort).
 */
export function classifyScoreFloor(relevanceScore: number): ScoreFloorVerdict {
  if (Number.isFinite(relevanceScore) && relevanceScore < SCORE_FLOOR) {
    return { reject: true, reason: 'negative-score' };
  }
  return { reject: false };
}

// Below this word count a page is too thin to synthesize from (when it is also
// off-topic). Above it, the page is real content and the gate keeps it.
const WORD_FLOOR = 50;
// At or below this, the page is an essentially-empty shell ("Loading…", error
// stub) — reported as low-content rather than low-overlap. A dozen words of
// coherent prose is real (if off-topic) content, so this stays low.
const NEAR_EMPTY_WORDS = 10;
// Fraction of distinct query terms that must appear for a thin page to survive.
const OVERLAP_FLOOR = 0.1;

// Mainstream search-engine domain labels whose /search path is a results page.
// Matched on label boundaries (not substrings) so "task.evil.com" or
// "flask.palletsprojects.com" are never mistaken for "ask." engines.
const SEARCH_ENGINE_LABELS = new Set([
  'google',
  'bing',
  'duckduckgo',
  'yahoo',
  'baidu',
  'yandex',
  'ecosia',
  'startpage',
  'brave',
  'ask',
  'aol',
  'mojeek',
]);

const SERP_QUERY_PARAMS = ['q', 'p', 'query', 'search_query'];

function isSearchEngineHost(host: string): boolean {
  return host.split('.').some((label) => SEARCH_ENGINE_LABELS.has(label));
}

/**
 * Classify a candidate URL by shape alone (no fetch). A bare-root homepage or a
 * search-engine results page is junk for research synthesis. `includeDomains`
 * roots are exempt — if the caller scoped research to a domain, its root is an
 * intentional target.
 */
export function classifyUrlShape(url: string, includeDomains?: string[]): UrlShapeVerdict {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Unparseable URL can't be a useful source.
    return { reject: true, reason: 'homepage' };
  }

  const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
  const path = parsed.pathname.replace(/\/+$/, ''); // strip trailing slash(es)
  const hasQuery = parsed.search.length > 0;
  const lowerPath = path.toLowerCase();

  // SERP: blog-search results path on any host (catches the leaked JP source).
  if (/(^|\/)(blogsearch|blog-search)(\/|$)/.test(lowerPath)) {
    return { reject: true, reason: 'serp' };
  }

  // SERP: a mainstream engine's /search results path or q-style query param.
  if (isSearchEngineHost(host)) {
    const isSearchPath = lowerPath === '/search' || lowerPath.startsWith('/search/');
    const hasSearchParam = SERP_QUERY_PARAMS.some((p) => parsed.searchParams.has(p));
    if (isSearchPath || hasSearchParam) {
      return { reject: true, reason: 'serp' };
    }
  }

  // Homepage: bare root with no meaningful query — unless the host is an
  // explicit include_domains target.
  const isBareRoot = path === '' && !hasQuery;
  if (isBareRoot) {
    const exempt = (includeDomains ?? []).some((d) => {
      const dn = d.replace(/^www\./, '').toLowerCase();
      return host === dn || host.endsWith(`.${dn}`);
    });
    if (!exempt) {
      return { reject: true, reason: 'homepage' };
    }
  }

  return { reject: false };
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'for', 'nor', 'of', 'to', 'in', 'on',
  'at', 'by', 'with', 'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'that', 'this', 'these', 'those', 'it', 'its', 'into', 'than', 'then',
  'between', 'vs', 'versus', 'about', 'over', 'under', 'how', 'what', 'why',
  'when', 'which', 'who', 'do', 'does', 'using', 'use',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Distinct, stop-word-stripped content terms from the research question. Used
 * by the content gate to measure query overlap.
 */
export function queryContentTerms(question: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const w of tokenize(question)) {
    if (w.length < 2 || STOP_WORDS.has(w)) continue;
    if (seen.has(w)) continue;
    seen.add(w);
    terms.push(w);
  }
  return terms;
}

/**
 * Gate fetched (or snippet) content. Rejects only when the page is BOTH thin
 * AND off-topic — a short on-topic doc survives (high overlap) and a long page
 * survives (high word count). Fails open when there are no query terms.
 */
export function gateContent(markdown: string, queryTerms: string[]): ContentGateVerdict {
  const words = tokenize(markdown);
  if (words.length >= WORD_FLOOR) return { reject: false };

  if (queryTerms.length === 0) return { reject: false };

  const wordSet = new Set(words);
  const present = queryTerms.filter((t) => wordSet.has(t)).length;
  const overlap = present / queryTerms.length;
  if (overlap >= OVERLAP_FLOOR) return { reject: false };

  return {
    reject: true,
    reason: words.length <= NEAR_EMPTY_WORDS ? 'low-content' : 'low-overlap',
  };
}
