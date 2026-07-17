import { STEALTH_CHROME_MAJOR } from './stealth.js';
import type { DomainClearance } from '../cache/store.js';

/**
 * Anti-bot clearance reuse (S-A2). Pure, browser-engine-free helpers that decide
 * whether a stored clearance (see {@link DomainClearance}) may be replayed for a
 * given fetch tier, and shape the cookie for the two injection paths (a browser
 * `context.addCookies(...)` cookie, or a `Cookie:` request header). Kept
 * dependency-light so the tiers stay decoupled and the rules are unit-testable
 * without a DB or a live page.
 */

/** The single anti-bot clearance cookie name we mint / replay. */
export const CLEARANCE_COOKIE_NAME = 'cf_clearance';

/** The tier that will CONSUME (present) a clearance on the next fetch. */
export type ClearanceTier = 'browser' | 'tls' | 'http';

/**
 * Whether a clearance minted against `clearanceUa` may be presented by `tier`.
 *
 * The browser tier renders through Chromium advertising a fixed Chrome identity
 * (the pinned {@link STEALTH_CHROME_MAJOR}); it CANNOT present a Firefox/Safari
 * UA, and a Chrome UA of a different major is a fingerprint mismatch a bot wall
 * will reject. So the browser tier only accepts a Chrome-major-matching UA.
 *
 * The header tiers (tls/http) inject the cookie as a `Cookie:` header rather
 * than re-presenting the minting UA byte-for-byte; cross-tier reuse there is
 * deliberately BEST-EFFORT (a different JA3 may still be re-challenged, which
 * the re-validation path handles), so any stored UA is allowed.
 */
export function uaMatchesTier(clearanceUa: string, tier: ClearanceTier): boolean {
  if (tier !== 'browser') return true;
  const m = clearanceUa.match(/Chrome\/(\d+)\./);
  if (!m) return false;
  return Number(m[1]) === STEALTH_CHROME_MAJOR;
}

/**
 * True when the clearance is still valid at `now` (epoch ms). Fails CLOSED: an
 * unparseable / empty `expiresAt` is treated as stale so a malformed row is
 * never replayed.
 */
export function isClearanceFresh(clearance: DomainClearance, now: number): boolean {
  const exp = Date.parse(clearance.expiresAt);
  if (!Number.isFinite(exp)) return false;
  return now < exp;
}

/**
 * Extract the raw cf_clearance token from a stored cookie string
 * (`cf_clearance=<value>`). Returns null when the stored value is not a
 * cf_clearance cookie or carries no value.
 */
export function clearanceCookieValue(cookie: string): string | null {
  const idx = cookie.indexOf('=');
  if (idx <= 0) return null;
  const name = cookie.slice(0, idx).trim();
  const value = cookie.slice(idx + 1).trim();
  if (name !== CLEARANCE_COOKIE_NAME || value.length === 0) return null;
  return value;
}

/**
 * A Playwright-shaped cookie for `context.addCookies(...)`, scoped to the
 * originating host so it is dropped on any cross-host redirect hop (the browser
 * only sends a cookie back to its own domain). Returns null when the stored
 * value is not a clearance cookie.
 */
export function parsedClearanceCookie(
  cookie: string,
  host: string,
): { name: string; value: string; domain: string; path: string } | null {
  const value = clearanceCookieValue(cookie);
  if (value == null) return null;
  return { name: CLEARANCE_COOKIE_NAME, value, domain: host, path: '/' };
}

// A clearance whose expiry we can't read (session cookie, expires -1) still
// proved a pass; give it a bounded default TTL so it is reusable briefly rather
// than discarded outright.
const DEFAULT_CLEARANCE_TTL_MS = 30 * 60 * 1000;

/**
 * Convert a Playwright cookie `expires` (epoch SECONDS) to an ISO string for the
 * store. A non-positive value (session cookie / unknown) maps to a short default
 * TTL from now rather than the epoch, so it is treated as fresh-but-brief.
 */
export function clearanceExpiresIso(expiresSeconds: number): string {
  if (!Number.isFinite(expiresSeconds) || expiresSeconds <= 0) {
    return new Date(Date.now() + DEFAULT_CLEARANCE_TTL_MS).toISOString();
  }
  return new Date(expiresSeconds * 1000).toISOString();
}
