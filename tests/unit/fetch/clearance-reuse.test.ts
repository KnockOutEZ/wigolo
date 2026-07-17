import { describe, it, expect } from 'vitest';
import {
  CLEARANCE_COOKIE_NAME,
  uaMatchesTier,
  isClearanceFresh,
  clearanceCookieValue,
  clearanceExpiresIso,
  parsedClearanceCookie,
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
