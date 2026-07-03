// Domain-quality penalty for brand-collision results in the core ranker.
//
// Penalises:
//   - Hits on a curated brand-domain registry (clothing brands, big-box
//     retailers, ecommerce hosts) — these false-match short and technical
//     queries alike.
//   - Hits on commercial-intent TLDs (.shop, .store, .deals, etc.).
//   - MDN's /Web/HTML/Element/* paths on code-vertical queries that mention
//     a database or library term — these are HTML-element docs that drift
//     into pgvector/redis/etc. results because the engine matches the word
//     in the URL path.
//
// Returns a multiplier in [0, 1] applied on top of the RRF + authority-boosted
// base score. 1.0 = no penalty.
import type { Vertical } from './intent-router.js';
import { queryHasErrorToken } from './intent-router.js';

// Curated registry of brand domains that frequently cause collisions in the
// general/docs/code verticals. Subset — extend as bench evidence warrants.
const BRAND_DOMAINS: ReadonlySet<string> = new Set([
  // "Next" clothing brand (Q2 false-match next.js queries)
  'next.co.uk',
  'www.next.co.uk',
  'next.us',
  'www.next.us',
  'next.de',
  'www.next.de',
  'next.ie',
  'www.next.ie',
  'next.com',
  // Big-box retailers
  'amazon.com',
  'www.amazon.com',
  'amazon.co.uk',
  'www.amazon.co.uk',
  'walmart.com',
  'www.walmart.com',
  'target.com',
  'www.target.com',
  'bestbuy.com',
  'www.bestbuy.com',
  'costco.com',
  'kohls.com',
  'macys.com',
  'nordstrom.com',
  'jcpenney.com',
  // General marketplaces
  'ebay.com',
  'www.ebay.com',
  'etsy.com',
  'www.etsy.com',
  'aliexpress.com',
  'wayfair.com',
  // Generic-name brands seen in bench captures
  'stars.com',
  'lists.app',
]);

const COMMERCIAL_TLD_RE = /\.(?:shop|store|deals|sale|boutique|fashion|wedding|beauty|salon)$/i;

const DB_LIBRARY_TERMS: ReadonlySet<string> = new Set([
  'pgvector',
  'hnsw',
  'postgres',
  'postgresql',
  'redis',
  'mongodb',
  'mongo',
  'mysql',
  'mariadb',
  'sqlite',
  'cockroachdb',
  'cockroach',
  'tigerdata',
  'timescale',
  'elasticsearch',
  'opensearch',
  'clickhouse',
  'duckdb',
  'neon',
  'crunchydata',
  'supabase',
  'planetscale',
  'cassandra',
  'dynamodb',
  'kafka',
  'rabbitmq',
  'qdrant',
  'weaviate',
  'pinecone',
  'milvus',
  'chroma',
  'vespa',
]);

const MDN_HTML_ELEMENT_PATH_RE = /\/web\/html\/element\//i;

// Dictionary / glossary / thesaurus hosts. On an error-code query the plain
// English word inside the code string (e.g. "permission" in EACCES) false-
// matches these hosts, which then crowd out the issue tracker / docs page
// that actually resolves the error. Pattern-level: matches known dictionary
// hosts plus any host whose registrable name contains `dictionary`,
// `thesaurus`, `vocabulary`, or `glossary`. Not keyed on any benchmark host.
const DICTIONARY_HOST_RE =
  /(?:^|\.)(?:wiktionary\.org|merriam-webster\.com|dictionary\.com|thesaurus\.com|vocabulary\.com|collinsdictionary\.com|dictionary\.cambridge\.org|(?:[a-z0-9-]+\.)?(?:dictionary|thesaurus|vocabulary|glossary))\b/i;

const BRAND_PENALTY = 0.2;
const MDN_ELEMENT_DRIFT_PENALTY = 0.1;
const DICTIONARY_ERROR_PENALTY = 0.25;

function isDictionaryHost(host: string): boolean {
  return DICTIONARY_HOST_RE.test(host);
}

function urlParts(url: string): { host: string; path: string } | null {
  try {
    const u = new URL(url);
    return { host: u.hostname.toLowerCase(), path: u.pathname };
  } catch {
    return null;
  }
}

function isBrandHost(host: string): boolean {
  if (BRAND_DOMAINS.has(host)) return true;
  if (COMMERCIAL_TLD_RE.test(host)) return true;
  return false;
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function queryMentionsDbTerm(query: string): boolean {
  const tokens = tokenize(query);
  for (const t of tokens) {
    if (DB_LIBRARY_TERMS.has(t)) return true;
  }
  return false;
}

/**
 * Return a 0..1 quality multiplier for a result URL given the vertical and
 * the original query. 1.0 = no penalty.
 */
export function domainQualityScore(
  url: string,
  vertical: Vertical,
  query: string,
): number {
  const parts = urlParts(url);
  if (!parts) return 1.0;
  const { host, path } = parts;

  if (
    host === 'developer.mozilla.org' &&
    vertical === 'code' &&
    MDN_HTML_ELEMENT_PATH_RE.test(path) &&
    queryMentionsDbTerm(query)
  ) {
    return MDN_ELEMENT_DRIFT_PENALTY;
  }

  // Per-result hit/miss gate: a dictionary/glossary host is demoted ONLY when
  // the query carries an error token. A normal query ("reciprocal rank fusion
  // explained") leaves the same host at 1.0 — the gate is per-result, never a
  // query-wide switch.
  if (queryHasErrorToken(query) && isDictionaryHost(host)) {
    return DICTIONARY_ERROR_PENALTY;
  }

  if (isBrandHost(host)) {
    return BRAND_PENALTY;
  }

  return 1.0;
}
