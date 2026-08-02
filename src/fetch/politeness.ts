/**
 * Origin-politeness helpers for the anti-bot tier. Pure functions so they are
 * unit-testable without a network or a DB. The router uses these to translate a
 * rate-limit response into a bounded per-host backoff window and to avoid
 * re-hammering a host that is actively refusing us.
 */

/** Backoff applied to a 429 that carries no parseable Retry-After header. */
export const DEFAULT_BACKOFF_MS = 60_000;

/**
 * Upper bound on any backoff window. A hostile or absurd Retry-After
 * ("99999") must not park a domain for hours — 5 minutes is the ceiling.
 */
export const MAX_BACKOFF_MS = 300_000;

/**
 * Parse an HTTP `Retry-After` header into a delay in milliseconds relative to
 * `nowMs`. Supports both header forms:
 *  - delta-seconds integer (`"120"`) → `120_000`
 *  - HTTP-date (`"Wed, 21 Oct 2026 07:28:00 GMT"`) → `Date.parse(...) - nowMs`,
 *    floored at 0 so a stale/past date never yields a negative delay.
 * Returns null for an empty, missing, or unparseable value.
 */
export function parseRetryAfter(headerValue: string | undefined, nowMs: number): number | null {
  if (!headerValue) return null;
  const trimmed = headerValue.trim();
  if (!trimmed) return null;

  // delta-seconds: a run of digits with no other characters.
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }

  // A bare number that is not pure digits (signed / decimal) is not a valid
  // delta-seconds and not a real HTTP-date. Reject it explicitly — Date.parse
  // would otherwise misread e.g. "-5" as a year.
  if (/^[+-]?\d*\.?\d+$/.test(trimmed)) return null;

  // Otherwise attempt an HTTP-date. Date.parse returns NaN for garbage.
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return null;
  return Math.max(0, parsed - nowMs);
}

/** Clamp a backoff delay into `[0, MAX_BACKOFF_MS]`. */
export function clampBackoffMs(ms: number): number {
  if (!Number.isFinite(ms) || ms < 0) return 0;
  return Math.min(ms, MAX_BACKOFF_MS);
}
