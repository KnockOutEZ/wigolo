import { describe, it, expect } from 'vitest';
import {
  CLEARANCE_COOKIE_NAME,
  uaMatchesTier,
  isClearanceFresh,
  clearanceCookieValue,
  clearanceExpiresIso,
  parsedClearanceCookie,
  routeMatchesClearance,
  isClearanceReusable,
} from '../../../src/fetch/clearance-reuse.js';
import { STEALTH_CHROME_MAJOR, resolveStealthUA } from '../../../src/fetch/stealth.js';

const CHROME_UA = resolveStealthUA();
const FIREFOX_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0';
const SAFARI_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const OLD_CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

describe('clearance-reuse: uaMatchesTier', () => {
  it('browser tier requires a Chrome UA matching the pinned major — stealth UA matches', () => {
    expect(uaMatchesTier(CHROME_UA, 'browser')).toBe(true);
  });

  it('browser tier REFUSES a Firefox UA (Chromium cannot present it)', () => {
    expect(uaMatchesTier(FIREFOX_UA, 'browser')).toBe(false);
  });

  it('browser tier REFUSES a Safari UA', () => {
    expect(uaMatchesTier(SAFARI_UA, 'browser')).toBe(false);
  });

  it('browser tier REFUSES a Chrome UA whose major differs from the pin', () => {
    expect(uaMatchesTier(OLD_CHROME_UA, 'browser')).toBe(false);
    // sanity: the pin is what we expect
    expect(CHROME_UA).toContain(`Chrome/${STEALTH_CHROME_MAJOR}`);
  });

  it('header tiers (tls/http) accept any UA — cross-tier reuse is best-effort', () => {
    expect(uaMatchesTier(FIREFOX_UA, 'tls')).toBe(true);
    expect(uaMatchesTier(SAFARI_UA, 'http')).toBe(true);
    expect(uaMatchesTier(CHROME_UA, 'tls')).toBe(true);
  });
});

describe('clearance-reuse: freshness', () => {
  it('an unexpired clearance is fresh', () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(isClearanceFresh({ cookie: 'x', ua: CHROME_UA, tier: 'browser', expiresAt: future }, Date.now())).toBe(true);
  });

  it('an expired clearance is NOT fresh', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(isClearanceFresh({ cookie: 'x', ua: CHROME_UA, tier: 'browser', expiresAt: past }, Date.now())).toBe(false);
  });

  it('an unparseable expiresAt is NOT fresh (fail closed)', () => {
    expect(isClearanceFresh({ cookie: 'x', ua: CHROME_UA, tier: 'browser', expiresAt: 'not-a-date' }, Date.now())).toBe(false);
  });
});

describe('clearance-reuse: cookie parsing', () => {
  it('extracts the cf_clearance value from the stored cookie string', () => {
    expect(clearanceCookieValue('cf_clearance=abc123')).toBe('abc123');
  });

  it('returns null when the stored cookie is not a cf_clearance cookie', () => {
    expect(clearanceCookieValue('other=1')).toBeNull();
    expect(clearanceCookieValue('')).toBeNull();
  });

  it('CLEARANCE_COOKIE_NAME is cf_clearance', () => {
    expect(CLEARANCE_COOKIE_NAME).toBe('cf_clearance');
  });

  it('parsedClearanceCookie yields a Playwright-shaped cookie for a host', () => {
    const c = parsedClearanceCookie('cf_clearance=tok', 'example.com');
    expect(c).toEqual({ name: 'cf_clearance', value: 'tok', domain: 'example.com', path: '/' });
  });

  it('parsedClearanceCookie returns null for a non-clearance cookie', () => {
    expect(parsedClearanceCookie('nope=1', 'example.com')).toBeNull();
  });
});

describe('clearance-reuse: routeMatchesClearance (route-identity gate)', () => {
  it('exact route match is reusable (same proxy egress)', () => {
    expect(routeMatchesClearance('http://proxy:8080', 'http://proxy:8080')).toBe(true);
  });

  it('a proxy-minted clearance is REFUSED from a direct route (route-identity mismatch)', () => {
    expect(routeMatchesClearance('http://proxy:8080', 'direct')).toBe(false);
  });

  it('a direct-minted clearance is REFUSED from a proxy route', () => {
    expect(routeMatchesClearance('direct', 'http://proxy:8080')).toBe(false);
  });

  it('two DIFFERENT proxies are a mismatch (clearance is IP-bound)', () => {
    expect(routeMatchesClearance('http://proxy-a:8080', 'http://proxy-b:8080')).toBe(false);
  });

  it('direct-to-direct matches', () => {
    expect(routeMatchesClearance('direct', 'direct')).toBe(true);
  });

  it('a legacy row (undefined route) is treated as direct — matches a direct current route', () => {
    expect(routeMatchesClearance(undefined, 'direct')).toBe(true);
  });

  it('a legacy row (undefined route) is REFUSED from a proxy route', () => {
    expect(routeMatchesClearance(undefined, 'http://proxy:8080')).toBe(false);
  });

  it('an empty-string stored route is treated as direct (legacy/NULL surrogate)', () => {
    expect(routeMatchesClearance('', 'direct')).toBe(true);
    expect(routeMatchesClearance('', 'http://proxy:8080')).toBe(false);
  });
});

describe('clearance-reuse: isClearanceReusable (composed eligibility)', () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  const past = new Date(Date.now() - 60_000).toISOString();

  it('reuses ONLY when fresh AND UA-ok AND route-matches', () => {
    const c = { cookie: 'cf_clearance=x', ua: CHROME_UA, tier: 'browser', expiresAt: future, solvedRoute: 'direct' };
    expect(isClearanceReusable(c, 'browser', 'direct', Date.now())).toBe(true);
  });

  it('refuses on route mismatch even when fresh + UA-ok', () => {
    const c = { cookie: 'cf_clearance=x', ua: CHROME_UA, tier: 'browser', expiresAt: future, solvedRoute: 'http://proxy:8080' };
    expect(isClearanceReusable(c, 'browser', 'direct', Date.now())).toBe(false);
  });

  it('refuses when stale even if route + UA match', () => {
    const c = { cookie: 'cf_clearance=x', ua: CHROME_UA, tier: 'browser', expiresAt: past, solvedRoute: 'direct' };
    expect(isClearanceReusable(c, 'browser', 'direct', Date.now())).toBe(false);
  });

  it('refuses on UA mismatch (Firefox-minted for the browser tier) even if route + fresh', () => {
    const c = { cookie: 'cf_clearance=x', ua: FIREFOX_UA, tier: 'browser', expiresAt: future, solvedRoute: 'direct' };
    expect(isClearanceReusable(c, 'browser', 'direct', Date.now())).toBe(false);
  });

  it('a legacy row (no solvedRoute) is reusable on a direct route, refused on a proxy route', () => {
    const legacy = { cookie: 'cf_clearance=x', ua: CHROME_UA, tier: 'browser', expiresAt: future };
    expect(isClearanceReusable(legacy, 'browser', 'direct', Date.now())).toBe(true);
    expect(isClearanceReusable(legacy, 'browser', 'http://proxy:8080', Date.now())).toBe(false);
  });

  it('refuses when the stored cookie is not a cf_clearance value', () => {
    const c = { cookie: 'other=1', ua: CHROME_UA, tier: 'browser', expiresAt: future, solvedRoute: 'direct' };
    expect(isClearanceReusable(c, 'browser', 'direct', Date.now())).toBe(false);
  });
});

describe('clearance-reuse: expiry ISO from Playwright cookie seconds', () => {
  it('converts epoch SECONDS to an ISO string', () => {
    const epochSeconds = 1893456000; // 2030-01-01T00:00:00Z
    expect(clearanceExpiresIso(epochSeconds)).toBe(new Date(epochSeconds * 1000).toISOString());
  });

  it('a non-positive / session cookie expiry (-1) yields a short default TTL in the future', () => {
    const iso = clearanceExpiresIso(-1);
    expect(Date.parse(iso)).toBeGreaterThan(Date.now());
  });
});
