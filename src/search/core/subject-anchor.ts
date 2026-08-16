/**
 * Does the result set belong to the subject the query asked for?
 *
 * WHY: the brand-collision signal used to be decided from the SPELLING of the
 * query — a capitalisation heuristic ("looks like a proper noun") crossed with
 * two hardcoded word lists. That inverts the signal in both directions:
 *
 *   1. it is SILENT on the queries that actually poison a result set, because
 *      the everyday words that collide with a brand or a dictionary entry
 *      ("scrape", "ArchiveBox") are not in any finite noun list; and
 *   2. it FIRES on distinctive coinages ("DuckDB docs", "ArchiveBox setup")
 *      whose own project site owns every top slot — the case LEAST in need of
 *      a warning.
 *
 * Name distinctiveness is the wrong question. The right one is decided against
 * the results, as a PER-RESULT hit/miss predicate tallied over the examined set
 * — never a query-wide boolean, which cannot tell a poisoned result set from a
 * healthy one because it never looks at the results at all.
 *
 * CRITICAL BOUNDARY — what this file may and may not conclude. An absent
 * hostname is NOT evidence of a wrong subject. Concepts, diseases, acronyms and
 * API symbols ("photosynthesis", "ADHD", "useState") own no domain, and their
 * CORRECT answer is a third-party reference site that can never be named after
 * them. Treating "no site is named X" as proof of collision fires on the entire
 * encyclopedic class. So a result counts as belonging to the subject when
 * EITHER the site is named after it OR the page itself is titled about it, and
 * the warning requires positive evidence: not one examined result is about
 * anything called X.
 */

/**
 * Site-naming suffixes, kept deliberately tiny because each one is a licence
 * for a domain to claim a word it does not own. Applied to BOTH sides: a
 * hostname label may shed one to match the term (`typescriptlang.org` is
 * TypeScript) and the term may shed one to match a label (`React.js` is
 * `react.dev`).
 *
 * ⚠️ There is NO "is the residue a real word" check here and there cannot
 * cheaply be one — the only thing keeping `bestbuy` from reading as "best" is
 * that `buy` is not on this list. Adding a commerce verb (buy/shop/store), an
 * article (`the` — which made `thespruce.com` claim "spruce" and
 * `theguardian.com` claim "guardian"), or a possessive (`my` — which made
 * `mysql.com` claim "sql") re-creates that bug wholesale. Prefix affixes
 * (`get`/`try`/`use`) were removed for the same reason: they made `getaway.com`
 * claim "away" and `usenet` claim "net", and nothing needed them.
 */
const SUFFIX_AFFIXES: readonly string[] = ['js', 'lang'];

/** Longest run of title words joined when testing a punctuated name. */
const MAX_TITLE_JOIN = 4;

/** Hosts where the SECOND path segment names a project (`/owner/repo`). */
const CODE_FORGE_HOSTS: ReadonlySet<string> = new Set([
  'github.com', 'gitlab.com', 'bitbucket.org', 'codeberg.org', 'sr.ht',
]);

const MIN_TERM_LENGTH = 3;
const MAX_TERM_LENGTH = 30;

/** How many top results the tally examines. */
export const SUBJECT_ANCHOR_SAMPLE = 3;

/** A result as far as this predicate is concerned. */
export interface AnchorCandidate {
  url: string;
  title?: string;
}

export interface SubjectAnchorAttrition {
  /** The normalised query subject the predicate was run against. */
  term: string;
  /** Results examined (at most SUBJECT_ANCHOR_SAMPLE). */
  candidates: number;
  /** Results that ARE about the query's subject. */
  named: number;
  /** Results that are not. */
  unnamed: number;
  /** Hostnames of the results that are not about the subject, in rank order. */
  unnamed_hosts: string[];
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

/** `value` with one trailing site suffix removed, or null when it has none. */
function withoutSiteSuffix(value: string): string | null {
  for (const affix of SUFFIX_AFFIXES) {
    if (value.length > affix.length + MIN_TERM_LENGTH - 1 && value.endsWith(affix)) {
      return value.slice(0, value.length - affix.length);
    }
  }
  return null;
}

/**
 * True when a hostname label and a term denote the same name once one site
 * suffix is allowed on EITHER side. Symmetry matters: `typescriptlang` -> the
 * term needs the label to shed one, and `React.js` -> `reactjs` needs the TERM
 * to shed one to reach `react.dev`. Stripping only the label made every dotted
 * product name fail to match its own site.
 */
function matchesThroughSiteAffix(label: string, term: string): boolean {
  if (term.length < MIN_TERM_LENGTH) return false;
  if (withoutSiteSuffix(label) === term) return true;
  if (withoutSiteSuffix(term) === label) return true;
  return false;
}

/**
 * Is this result hosted at a site NAMED after `term`?
 *
 * Satisfied by a hostname label, or an `owner/repo` pair on a code forge where
 * that IS the naming convention. Deliberately NOT satisfied by the term
 * appearing anywhere else in the URL: a path segment is where a dictionary puts
 * the WORD (`/dictionary/english/scrape`, `thefreedictionary.com/best` — the
 * latter measured anchoring a live "best" search until this was narrowed). Nor
 * by mere containment in a label: "themarginalian" swallows "marginalia" while
 * being a different publication, and "bestbuy" swallows "best".
 *
 * KNOWN LIMIT: this cannot tell WHICH sense a name refers to. `guardian.com.my`
 * is a pharmacy chain and still anchors "guardian". No result-only signal can
 * resolve that — it needs the caller's intent — so the detector stays silent
 * there rather than guessing.
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
    // `/owner` is an organisation landing page and `/owner/repo` a project —
    // on a forge both segments are names, not article paths.
    const segments = new URL(url).pathname.split('/').filter(Boolean);
    if (segments.slice(0, 2).some((s) => normalizeAlnum(s) === term)) return true;
  }

  return false;
}

/**
 * Is this result's PAGE about `term`, whoever hosts it?
 *
 * This is the channel that makes the detector safe for subjects that own no
 * domain: Wikipedia is not named "photosynthesis" and Mayo Clinic is not named
 * "ADHD", but their pages are titled about exactly those things. Matched on
 * whole title tokens so "Archive of Our Own" does not read as "ArchiveBox".
 *
 * Short runs of adjacent words are also joined, because the term arrives with
 * its punctuation REMOVED ("React.js" -> "reactjs") while a title is split ON
 * punctuation (["react", "js"]). Without the join a dotted or hyphenated name
 * could never match a page titled with that exact name — the asymmetry fired
 * the warning on "React.js" while `react.dev` sat at rank 1.
 */
export function titleNamesSubject(title: string | undefined, term: string): boolean {
  if (!title || !term) return false;
  const words = title.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (words.includes(term)) return true;

  for (let start = 0; start < words.length; start++) {
    let joined = '';
    for (let n = 0; n < MAX_TITLE_JOIN && start + n < words.length; n++) {
      joined += words[start + n];
      if (joined.length > term.length) break;
      if (n > 0 && joined === term) return true;
    }
  }
  return false;
}

/** PER-RESULT predicate: is this result about `term` at all? */
export function namesSubject(candidate: AnchorCandidate, term: string): boolean {
  return anchorsSubject(candidate.url, term) || titleNamesSubject(candidate.title, term);
}

/** Hit/miss tally of `namesSubject` over the examined top results. */
export function computeSubjectAnchorAttrition(
  candidates: readonly AnchorCandidate[],
  term: string,
): SubjectAnchorAttrition {
  const examined = candidates.slice(0, SUBJECT_ANCHOR_SAMPLE);
  const unnamedHosts: string[] = [];
  let named = 0;

  for (const candidate of examined) {
    if (namesSubject(candidate, term)) {
      named++;
    } else {
      const host = hostOf(candidate.url);
      if (host) unnamedHosts.push(host);
    }
  }

  return {
    term,
    candidates: examined.length,
    named,
    unnamed: examined.length - named,
    unnamed_hosts: unnamedHosts,
  };
}

/**
 * True when the tally is positive evidence that the top results are about a
 * different subject than the query intends — that is, not one of them is about
 * anything called `term`, by site name or by page title.
 *
 * Both gates are integer counts at the tally's own resolution, so neither can
 * silently mean "never". The named count must be EXACTLY zero: unanimity, not a
 * majority — a single result about the subject always silences the warning.
 * That is deliberately the conservative direction, since the failure being
 * fixed is over-firing; it does mean a poisoned result set with one good hit in
 * it goes unreported, which is the cheaper mistake.
 *
 * At least two results must have been examined, because one page is a thin
 * result set rather than evidence about a subject. There is NO requirement that
 * the results come from different sites: one site returning three pages about
 * something else — a search for "ArchiveBox" that returns three encyclopedia
 * articles on unrelated archives — is the clearest collision there is.
 */
export function isSubjectCollision(attrition: SubjectAnchorAttrition): boolean {
  if (attrition.candidates < 2) return false;
  return attrition.named === 0;
}
