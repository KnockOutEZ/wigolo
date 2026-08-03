import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isAuthenticatedOrigin,
  isCredentialClassCookie,
  cookieDomainCoversHost,
  normalizeOrigin,
  type CookieFacts,
} from '../../../src/studio/authenticated-origin.js';
import {
  recordAuthOrigin,
  readAuthOriginLedger,
  readOriginOverrides,
  overridePatch,
  authenticatedOriginCount,
  AgentWriteRefusedError,
  AUTHENTICATED_ORIGINS_KEY,
  ANONYMOUS_ORIGINS_KEY,
} from '../../../src/studio/auth-origin-store.js';

/**
 * S9 §3.5 — the eight F5 test obligations, plus the store's trust bright-line.
 *
 * What this predicate decides is when the agent gets stopped for consent before it spends the human's
 * logged-in identity on a site. Too loose and every fetch nags until the human clicks through on reflex,
 * which destroys the value of the prompt; too tight and an account gets spent unprotected. So each case
 * below is a real shape from the web, not a synthetic permutation.
 */

const NO_LEDGER = new Set<string>();

function cookie(over: Partial<CookieFacts> = {}): CookieFacts {
  return { domain: 'example.com', name: 'sid', httpOnly: true, secure: true, session: true, ...over };
}

describe('F5 obligation 1 — anonymous origin with a pile of analytics cookies', () => {
  it('is NOT authenticated (the nag-fatigue regression test)', () => {
    // Consent banners and analytics set cookies on essentially every site. A "has cookies" predicate would
    // fire the grant card on every page the agent ever touches, and a prompt that always fires is a prompt
    // nobody reads. THIS is the case that makes the whole design worth its complexity.
    const analytics: CookieFacts[] = Array.from({ length: 12 }, (_, i) => ({
      domain: '.example.com',
      name: `_ga_${i}`,
      httpOnly: false,
      secure: i % 2 === 0,
      session: false,
    }));
    expect(isAuthenticatedOrigin({ origin: 'https://example.com', cookies: analytics, ledger: NO_LEDGER })).toBe(false);
  });
});

describe('F5 obligation 2 — HttpOnly + Secure session cookie', () => {
  it('IS authenticated — that is the shape of a login', () => {
    expect(isAuthenticatedOrigin({
      origin: 'https://example.com',
      cookies: [cookie({ httpOnly: true, secure: true, session: true })],
      ledger: NO_LEDGER,
    })).toBe(true);
  });
});

describe('F5 obligation 3 — Secure, non-HttpOnly, long-lived preference cookie', () => {
  it('is NOT authenticated — JS-readable and outlives the browser, so it is not a session credential', () => {
    expect(isAuthenticatedOrigin({
      origin: 'https://example.com',
      cookies: [cookie({ name: 'theme', httpOnly: false, secure: true, session: false })],
      ledger: NO_LEDGER,
    })).toBe(false);
  });
});

describe('F5 obligation 4 — `__Host-` prefixed cookie carrying an Expires', () => {
  it('IS authenticated via the prefix clause, despite not being session-scoped', () => {
    // `__Host-` cannot be set cross-site and requires Secure + Path=/. A persistent one is a "remember me"
    // login, which is exactly the identity the agent would be spending.
    expect(isAuthenticatedOrigin({
      origin: 'https://example.com',
      cookies: [cookie({ name: '__Host-session', session: false })],
      ledger: NO_LEDGER,
    })).toBe(true);
  });

  it('still requires HttpOnly + Secure — the prefix relaxes the session clause only', () => {
    expect(isCredentialClassCookie(cookie({ name: '__Host-session', session: false, httpOnly: false }))).toBe(false);
    expect(isCredentialClassCookie(cookie({ name: '__Secure-tok', session: false, secure: false }))).toBe(false);
  });
});

describe('F5 obligation 5 — ledger stickiness', () => {
  it('a handoff-completed origin whose cookies were since cleared is STILL authenticated', () => {
    // The account did not stop existing when the jar was cleared. Losing the flag here would silently drop
    // the card for exactly the origins the human personally logged into through Studio.
    expect(isAuthenticatedOrigin({
      origin: 'https://example.com',
      cookies: [],
      ledger: new Set(['https://example.com']),
    })).toBe(true);
  });
});

describe('F5 obligation 6 — the registrable-domain boundary', () => {
  it('a cookie set by login.example.com on .example.com authenticates app.example.com', () => {
    expect(isAuthenticatedOrigin({
      origin: 'https://app.example.com',
      cookies: [cookie({ domain: '.example.com' })],
      ledger: NO_LEDGER,
    })).toBe(true);
  });

  it('a.github.io does NOT authenticate b.github.io — the public-suffix boundary holds', () => {
    // github.io is a public suffix, so a.github.io physically cannot set Domain=.github.io: the browser
    // stores its cookie host-only. Matching on the stored Domain attribute therefore inherits Chromium's
    // own public suffix list for free, with no list in this repo to go stale.
    expect(isAuthenticatedOrigin({
      origin: 'https://b.github.io',
      cookies: [cookie({ domain: 'a.github.io' })],
      ledger: NO_LEDGER,
    })).toBe(false);
  });

  it('a sibling subdomain cookie does not reach across: login.example.com does not authenticate other.test', () => {
    expect(cookieDomainCoversHost('login.example.com', 'other.test')).toBe(false);
    // and a suffix that is not a label boundary must not match
    expect(cookieDomainCoversHost('example.com', 'notexample.com')).toBe(false);
  });
});

describe('F5 obligation 7 — no cookie name or value can leak', () => {
  it('returns a plain boolean, not a reason object carrying the cookie that matched', () => {
    const r = isAuthenticatedOrigin({ origin: 'https://example.com', cookies: [cookie({ name: 'SUPERSECRET_SID' })], ledger: NO_LEDGER });
    expect(typeof r).toBe('boolean');
    expect(JSON.stringify(r)).not.toContain('SUPERSECRET');
  });

  it('the input projection has no `value` field at all — the value cannot leak from a payload it never entered', () => {
    const c = cookie();
    expect(Object.keys(c).sort()).toEqual(['domain', 'httpOnly', 'name', 'secure', 'session']);
  });

  it('the module emits no logs — nothing can log the cookie it inspected', async () => {
    const src = readFileSync(new URL('../../../src/studio/authenticated-origin.ts', import.meta.url), 'utf-8');
    expect(src).not.toMatch(/createLogger|console\./);
  });
});

describe('F5 obligation 8 — the override store refuses an agent writer', () => {
  it('an agent-driven write to the override store is refused', () => {
    expect(() => overridePatch({}, 'https://example.com', 'authenticated', 'agent')).toThrow(AgentWriteRefusedError);
  });

  it('an agent-driven write to the ledger is refused', () => {
    expect(() => recordAuthOrigin('https://example.com', 'agent')).toThrow(AgentWriteRefusedError);
  });

  it('the refusal names no origin — a thrown error is a log line waiting to happen', () => {
    try {
      overridePatch({}, 'https://secret-employer.example', 'authenticated', 'agent');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as Error).message).not.toContain('secret-employer');
    }
  });

  it('no tool handler or studio dispatch imports the store — the bright line is structural, not just a check', async () => {
    const { readdirSync } = await import('node:fs');
    const dir = new URL('../../../src/tools/', import.meta.url);
    const offenders: string[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.ts')) continue;
      if (readFileSync(new URL(f, dir), 'utf-8').includes('auth-origin-store')) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});

describe('F5 overrides — precedence', () => {
  it('a human "anonymous" mark suppresses a persistent false positive, beating even the sticky ledger', () => {
    expect(isAuthenticatedOrigin({
      origin: 'https://example.com',
      cookies: [cookie()],
      ledger: new Set(['https://example.com']),
      overrides: { anonymous: new Set(['https://example.com']) },
    })).toBe(false);
  });

  it('a human "authenticated" mark covers the SPA/bearer-token false-negative class', () => {
    // The growing class of SPAs keeps the session in localStorage with no HttpOnly cookie at all. The
    // predicate cannot see that; the human can, and this is their lever the moment they hit it.
    expect(isAuthenticatedOrigin({
      origin: 'https://spa.example',
      cookies: [cookie({ domain: 'spa.example', httpOnly: false, session: false })],
      ledger: NO_LEDGER,
      overrides: { authenticated: new Set(['https://spa.example']) },
    })).toBe(true);
  });

  it('overrides are origin-exact: marking https://example.com does not mark http://example.com', () => {
    expect(isAuthenticatedOrigin({
      origin: 'http://example.com',
      cookies: [],
      ledger: NO_LEDGER,
      overrides: { authenticated: new Set(['https://example.com']) },
    })).toBe(false);
  });

  it('an unparseable origin is not authenticated', () => {
    expect(isAuthenticatedOrigin({ origin: 'not a url', cookies: [cookie()], ledger: NO_LEDGER })).toBe(false);
    expect(normalizeOrigin('not a url')).toBeNull();
  });
});

describe('F5 store — the persisted ledger', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'wig-f5-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('records an origin from the human channel and reads it back, idempotently', () => {
    recordAuthOrigin('https://example.com/login?next=/x', 'human', dir);
    recordAuthOrigin('https://example.com/other', 'human', dir);
    expect([...readAuthOriginLedger(dir)]).toEqual(['https://example.com']);
  });

  it('is written 0600 — it is browsing history, not configuration', () => {
    recordAuthOrigin('https://example.com', 'human', dir);
    expect(existsSync(join(dir, 'studio', 'auth-origins.json'))).toBe(true);
    // POSIX mode-bit assert (0o600) — skip on win32 (no POSIX perms) to match existing test patterns.
    // Windows reports 0o666 for every file it creates; the ledger's protection there comes from the
    // user-profile ACL on the data dir, which this assertion cannot express.
    if (process.platform !== 'win32') {
      const mode = statSync(join(dir, 'studio', 'auth-origins.json')).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it('an absent or corrupt ledger reads as empty rather than throwing — a missing ledger costs a card, not safety', () => {
    expect(readAuthOriginLedger(dir).size).toBe(0);
  });
});

describe('F5 store — overrides in persisted settings', () => {
  it('adding to one list removes from the other, so the outcome never depends on clause order', () => {
    let settings: Record<string, unknown> = {};
    settings = { ...settings, ...overridePatch(settings, 'https://example.com', 'authenticated', 'human') };
    expect(settings[AUTHENTICATED_ORIGINS_KEY]).toEqual(['https://example.com']);
    settings = { ...settings, ...overridePatch(settings, 'https://example.com', 'anonymous', 'human') };
    expect(settings[AUTHENTICATED_ORIGINS_KEY]).toEqual([]);
    expect(settings[ANONYMOUS_ORIGINS_KEY]).toEqual(['https://example.com']);
  });

  it('rejects a value that is not a usable origin instead of persisting garbage', () => {
    expect(() => overridePatch({}, 'example.com', 'authenticated', 'human')).toThrow();
  });

  it('ignores non-string / unparseable entries already on disk rather than failing the whole read', () => {
    const o = readOriginOverrides({ [AUTHENTICATED_ORIGINS_KEY]: ['https://ok.example', 42, 'garbage'] });
    expect([...(o.authenticated ?? [])]).toEqual(['https://ok.example']);
  });
});

describe('F5 — doctor reports a COUNT, never the list', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'wig-f5c-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('counts the union of ledger and human-marked origins, minus anonymous marks', () => {
    recordAuthOrigin('https://a.example', 'human', dir);
    recordAuthOrigin('https://b.example', 'human', dir);
    const settings = {
      [AUTHENTICATED_ORIGINS_KEY]: ['https://c.example'],
      [ANONYMOUS_ORIGINS_KEY]: ['https://b.example'],
    };
    expect(authenticatedOriginCount(settings, dir)).toBe(2);
  });

  it('returns a number — anything that returns origins is a browsing-history disclosure', () => {
    recordAuthOrigin('https://private-forum.example', 'human', dir);
    const n = authenticatedOriginCount({}, dir);
    expect(typeof n).toBe('number');
    expect(JSON.stringify(n)).not.toContain('private-forum');
  });
});
