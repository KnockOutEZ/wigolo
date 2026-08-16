/**
 * Does the result set belong to the subject the query asked for?
 *
 * WHY: the brand-collision signal used to be decided from the SPELLING of the
 * query — a capitalisation heuristic ("looks like a proper noun") crossed with
 * two hardcoded word lists. That inverts the signal in both directions:
 *
 *   1. it is SILENT on the queries that actually poison a result set, because
 *      the everyday words that collide with a brand or a dictionary entry
 *      ("scrape", "late", "Marginalia") are not in any finite noun list; and
 *   2. it FIRES on distinctive coinages ("DuckDB", "ArchiveBox") whose own
 *      project site owns every top slot — the case LEAST in need of a warning.
 *
 * Name distinctiveness is the wrong question. The right one is decided against
 * the results: does any top result actually belong to the query's subject? That
 * is a PER-RESULT hit/miss predicate tallied over the examined set — never a
 * query-wide boolean, which cannot tell a poisoned result set from a healthy
 * one because it never looks at the results at all.
 */

/**
 * Site-naming affixes a project pads its domain with. Stripping one lets
 * `typescriptlang.org` anchor "typescript" and `getbootstrap.com` anchor
 * "bootstrap". This is a closed set of SITE words — never subject names — so
 * the detector cannot be tuned by adding entities to it. One affix is stripped,
 * never a chain, and the residue must still be a real term: that is what keeps
 * `bestbuy` from reading as "best" and `themarginalian` from reading as
 * "marginalia".
 */
const SITE_AFFIXES: readonly string[] = [
  'lang', 'js', 'io', 'hq', 'app', 'dev', 'docs', 'doc', 'official',
  'project', 'get', 'try', 'use', 'the', 'my', 'go', 'web', 'site',
  'online', 'hub', 'labs', 'lab',
];

/** Hosts where the SECOND path segment names a project (`/owner/repo`). */
const CODE_FORGE_HOSTS: ReadonlySet<string> = new Set([
  'github.com', 'gitlab.com', 'bitbucket.org', 'codeberg.org', 'sr.ht',
]);

const MIN_TERM_LENGTH = 3;
const MAX_TERM_LENGTH = 30;

/** How many top results the anchor tally examines. */
export const SUBJECT_ANCHOR_SAMPLE = 3;

export interface SubjectAnchorAttrition {
  /** The normalised query subject the predicate was run against. */
  term: string;
  /** Results examined (at most SUBJECT_ANCHOR_SAMPLE). */
  candidates: number;
  /** Results that DO belong to the query's subject. */
  anchored: number;
  /** Results that do not. */
  unanchored: number;
  /** Distinct registrable domains among the examined results. */
  distinct_domains: number;
  /** Hostnames of the unanchored results, in rank order. */
  unanchored_hosts: string[];
}

function normalizeAlnum(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * The single subject term a query names, or null when the query does not name
 * one. A descriptive phrase ("react server components streaming") has no single
 * subject a site could be named after, so anchoring it against host names would
 * report a collision on every ordinary informational query.
 */
export function normalizeSubjectTerm(query: string): string | null {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (tokens.length !== 1) return null;
  const term = normalizeAlnum(tokens[0]);
  if (term.length < MIN_TERM_LENGTH || term.length > MAX_TERM_LENGTH) return null;
  if (!/^[a-z]/.test(term)) return null;
  return term;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function pathSegmentsOf(url: string): string[] {
  try {
    return new URL(url).pathname.split('/').filter(Boolean);
  } catch {
    return [];
  }
}

/** Last two hostname labels — a cheap stand-in for the registrable domain. */
export function registrableDomainOf(url: string): string {
  const host = hostOf(url);
  if (!host) return '';
  const labels = host.split('.');
  return labels.length <= 2 ? host : labels.slice(-2).join('.');
}

/** True when one site affix can be removed from `label` to leave exactly `term`. */
function matchesThroughSiteAffix(label: string, term: string): boolean {
  if (term.length < MIN_TERM_LENGTH) return false;
  for (const affix of SITE_AFFIXES) {
    if (label.length <= affix.length) continue;
    if (label.startsWith(affix) && label.slice(affix.length) === term) return true;
    if (label.endsWith(affix) && label.slice(0, label.length - affix.length) === term) return true;
  }
  return false;
}

/**
 * PER-RESULT predicate: is this one result about `term`?
 *
 * A result belongs to the subject when a site is NAMED after it — a hostname
 * label, or a repository on a code forge, where `/owner/repo` is a naming
 * convention rather than a page path.
 *
 * Deliberately NOT satisfied by the term appearing anywhere else in the URL. A
 * path segment is not evidence: `/dictionary/english/scrape` and
 * `thefreedictionary.com/best` both put the term in the path while being pages
 * about the WORD, which is the single most common collision there is — and the
 * second was measured anchoring a live "best" search until this rule was
 * narrowed. Nor is mere containment in a label enough: "themarginalian"
 * swallows "marginalia" while being a different publication entirely, and
 * "bestbuy" swallows "best".
 */
export function anchorsSubject(url: string, term: string): boolean {
  if (!term) return false;
  const host = hostOf(url);
  if (!host) return false;

  for (const label of host.split('.')) {
    const normalized = normalizeAlnum(label);
    if (normalized === term) return true;
    if (matchesThroughSiteAffix(normalized, term)) return true;
  }

  if (CODE_FORGE_HOSTS.has(host.replace(/^www\./, ''))) {
    const segments = pathSegmentsOf(url);
    if (segments.length > 1 && normalizeAlnum(segments[1]) === term) return true;
  }

  return false;
}

/** Hit/miss tally of `anchorsSubject` over the examined top results. */
export function computeSubjectAnchorAttrition(
  urls: readonly string[],
  term: string,
): SubjectAnchorAttrition {
  const examined = urls.slice(0, SUBJECT_ANCHOR_SAMPLE);
  const domains = new Set<string>();
  const unanchoredHosts: string[] = [];
  let anchored = 0;

  for (const url of examined) {
    const domain = registrableDomainOf(url);
    if (domain) domains.add(domain);
    if (anchorsSubject(url, term)) {
      anchored++;
    } else {
      const host = hostOf(url);
      if (host) unanchoredHosts.push(host);
    }
  }

  return {
    term,
    candidates: examined.length,
    anchored,
    unanchored: examined.length - anchored,
    distinct_domains: domains.size,
    unanchored_hosts: unanchoredHosts,
  };
}

/**
 * True when the tally is evidence that the top results belong to a different
 * subject than the query intends.
 *
 * Both gates are integer counts at the tally's own resolution, so neither can
 * silently mean "never". The anchored count must be EXACTLY zero: unanimity,
 * not a majority — a single anchored result out of the examined N always
 * silences the warning. That is deliberately the conservative direction, since
 * the failure being fixed is over-firing; it does mean a poisoned result set
 * with one good hit in it goes unreported, which is the cheaper mistake.
 *
 * At least two results must have been examined, because one unanchored page is
 * a thin result set rather than evidence about a subject. There is NO
 * requirement that the unanchored results come from different sites: one site
 * returning three pages about something else — a search for "ArchiveBox" that
 * returns three encyclopedia articles on unrelated archives — is the clearest
 * collision there is, not a weaker one.
 */
export function isSubjectCollision(attrition: SubjectAnchorAttrition): boolean {
  if (attrition.candidates < 2) return false;
  return attrition.anchored === 0;
}
