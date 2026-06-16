/**
 * SSRF guard for the `watch` tool (and reused by `extraction/brand.ts` for
 * image-URL fetches). Applied to the watched URL and any webhook notification
 * URL at registration time, so a bad URL never reaches persistent state.
 *
 * The classification now lives in the shared `src/security/ssrf.ts`; this wrapper
 * preserves the watch path's exact contract — `guardUrl(raw, fieldLabel)` with its
 * `{ ok, reason, hint }` envelope — by delegating to `guardNavigation` with the
 * AGENT policy (block ALL loopback/private/link-local) and re-shaping the result.
 * Behavior is identical to the prior inline implementation.
 */

import { guardNavigation } from '../security/ssrf.js';

export interface SsrfRejection {
  ok: false;
  reason: string;
  hint: string;
}

export interface SsrfAllowed {
  ok: true;
  url: URL;
}

export type SsrfResult = SsrfAllowed | SsrfRejection;

/**
 * Guard a single URL string. Returns `{ ok:true, url }` on accept, or
 * `{ ok:false, reason, hint }` on reject. Callers pipe the reject payload
 * straight into a StageError envelope.
 */
export function guardUrl(raw: string, fieldLabel: string): SsrfResult {
  // Watch is agent-equivalent: loopback / private / link-local are all blocked.
  const r = guardNavigation(raw, { source: 'agent', allowPrivate: false });
  if (r.ok) return { ok: true, url: r.url };

  switch (r.code) {
    case 'empty':
      return {
        ok: false,
        reason: `${fieldLabel} is required and must be a non-empty string`,
        hint: 'Pass a fully qualified http(s) URL.',
      };
    case 'parse':
      return {
        ok: false,
        reason: `${fieldLabel} is not a valid URL`,
        hint: 'Pass a fully qualified http(s) URL (e.g. "https://example.com/path").',
      };
    case 'protocol':
      return {
        ok: false,
        reason: `${fieldLabel} uses a forbidden protocol (${r.protocol})`,
        hint: 'Only http: and https: are allowed.',
      };
    case 'blocked':
      return {
        ok: false,
        reason: `${fieldLabel} resolves to a loopback / private address (${r.host})`,
        hint: 'Public addresses only — localhost, 10/8, 127/8, 172.16/12, 192.168/16, 169.254/16, 0.0.0.0, ::1, fe80::/10, fc00::/7 are blocked.',
      };
  }
}
