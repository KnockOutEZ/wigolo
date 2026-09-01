/**
 * Registrable-domain (eTLD+1) reduction for the one telemetry prop that carries a host.
 *
 * The brief's Never list allows "registrable domain only" and forbids full URLs. A bare
 * `new URL(url).hostname` — which is what the fetch router's per-domain routing key uses
 * (`src/fetch/router.ts`) — is broader than that: `a.b.example.co.uk` would ship three
 * labels of site structure. There is no public-suffix helper in the tree, so this reduces
 * through an exact-pinned `tldts` (A-212-15).
 *
 * `src/studio/authenticated-origin.ts` deliberately refuses a public-suffix list, and that
 * is not a contradiction: there staleness would weaken a SECURITY predicate, so failing
 * open was unacceptable. Here staleness only coarsens analytics — a suffix the list has not
 * learned yet reduces to fewer labels, never more — which is the acceptable direction.
 */
import { getDomain } from 'tldts';

/**
 * Reduce a URL or hostname to its registrable domain, lowercased.
 *
 * @returns `null` when the input has no registrable domain — an IP literal, `localhost`, a
 * bare public suffix, or anything unparseable. Callers drop the event rather than
 * substituting a placeholder: a host we cannot reduce is a host we must not report.
 */
export function registrableDomain(input: string): string | null {
  if (typeof input !== 'string' || input.length === 0) return null;
  const domain = getDomain(input, { allowPrivateDomains: false });
  return domain === null || domain.length === 0 ? null : domain.toLowerCase();
}

/**
 * Is this value ALREADY a bare registrable domain?
 *
 * This is the queue-boundary guard, not a convenience: it is what makes the `domain` prop
 * kind unable to smuggle free text. A full URL, a path, a query string, a port, a
 * whitespace-bearing string and a multi-label host all fail it, because none of them is
 * equal to its own eTLD+1.
 */
export function isRegistrableDomain(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value !== value.trim().toLowerCase()) return false;
  if (/[\s/:?#@]/.test(value)) return false;
  return registrableDomain(value) === value;
}
