/**
 * Attribution for a zero-result search that a domain scope caused.
 *
 * WHY: a search that returns nothing has two distinct causes that the pipeline
 * used to collapse into one message ("all engines failed or no results"):
 *
 *   1. no engine returned anything      -> availability problem; retry/backoff
 *   2. engines returned plenty and the  -> scoping problem; widen include_domains
 *      caller's include_domains scope
 *      dropped every one of them
 *
 * Reporting (1) when the truth is (2) sends the caller to the wrong fix. The
 * distinction is decided PER RESULT — how many results actually failed the
 * include predicate — never on the query-wide "include_domains was set and the
 * response is empty", which cannot tell a dead engine pool from an over-narrow
 * scope.
 *
 * The host predicate lives here and is imported by the orchestrator's hard
 * whitelist, so the attribution is computed with literally the same rule that
 * dropped the results. Two copies could drift and make the notice lie.
 */

export interface DomainFilterAttrition {
  /** The scope the caller asked for, as requested. */
  include_domains: string[];
  /** Results that existed BEFORE the include filter ran. */
  candidates: number;
  /** Results that satisfied the include predicate. */
  matched: number;
  /** Results the include predicate rejected. */
  dropped: number;
}

export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function matchesDomain(host: string, domain: string): boolean {
  const needle = domain.toLowerCase().replace(/^\./, '');
  if (!host) return false;
  return host === needle || host.endsWith(`.${needle}`);
}

/** Per-result hit/miss tally of the include predicate over the pre-filter set. */
export function computeIncludeDomainAttrition(
  results: readonly { url: string }[],
  includeDomains?: string[],
): DomainFilterAttrition | undefined {
  if (!includeDomains?.length) return undefined;

  let matched = 0;
  for (const r of results) {
    const host = hostnameOf(r.url);
    if (host && includeDomains.some((d) => matchesDomain(host, d))) matched++;
  }

  return {
    include_domains: [...includeDomains],
    candidates: results.length,
    matched,
    dropped: results.length - matched,
  };
}

/** Fold attrition across dispatch waves (multi-query, auto-rewrite, backfill). */
export function mergeDomainAttrition(
  a: DomainFilterAttrition | undefined,
  b: DomainFilterAttrition | undefined,
): DomainFilterAttrition | undefined {
  if (!a) return b;
  if (!b) return a;
  return {
    include_domains: [...new Set([...a.include_domains, ...b.include_domains])],
    candidates: a.candidates + b.candidates,
    matched: a.matched + b.matched,
    dropped: a.dropped + b.dropped,
  };
}

/**
 * The user-facing cause, or undefined when the domain scope is NOT to blame.
 *
 * Fires only when engines produced candidates AND not one of them survived the
 * scope. `candidates === 0` is a genuine engine failure; `matched > 0` means
 * something downstream emptied the response and the scope is innocent.
 */
export function describeDomainFilterCause(
  attrition: DomainFilterAttrition | undefined,
): string | undefined {
  if (!attrition) return undefined;
  if (attrition.candidates === 0) return undefined;
  if (attrition.matched > 0) return undefined;

  const domains = attrition.include_domains.join(', ');
  const n = attrition.candidates;
  return (
    `no results after domain scoping: search engines returned ${n} result${n === 1 ? '' : 's'}, ` +
    `but none were on ${domains}. This is a scoping result, not an engine failure — ` +
    `widen or drop include_domains to see them.`
  );
}
