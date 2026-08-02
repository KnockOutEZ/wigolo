/**
 * Tests for the domain-routing inspection + reset store APIs backing
 * `wigolo tune`.
 *
 * Why: the self-tuning surface must let an operator SEE per-domain routing
 * state (TLS promotion, browser escalation, backoff windows, whether a
 * clearance is on file) and RESET it — WITHOUT ever exposing the live
 * clearance cookie value or the UA it was minted against. Those two columns
 * are session-bearing credentials; a projection that leaked them would turn a
 * read-only inspection command into a credential dump. The reset path must be
 * loud (throw) so a busy/locked DB surfaces as an actionable CLI error rather
 * than a silent no-op that leaves stale routing in place.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDatabase, closeDatabase, getDatabase } from '../../../src/cache/db.js';
import {
  listDomainRouting,
  resetDomainRouting,
  resetAllDomainRouting,
  recordTlsImpersonationSuccess,
  recordDomainClearance,
  recordBackoff,
  getDomainRouting,
  getDomainClearance,
  getBackoff,
} from '../../../src/cache/store.js';

const SEED_COOKIE = 'cf_clearance=SUPERSECRETcookievalue123';
const SEED_UA = 'Mozilla/5.0 (X11; SecretUA/1.0) AppleWebKit/537.36';

describe('listDomainRouting — projection', () => {
  beforeEach(() => { initDatabase(':memory:'); });
  afterEach(() => { closeDatabase(); });

  it('returns an empty array when no domains are tracked', () => {
    expect(listDomainRouting()).toEqual([]);
  });

  it('projects routing prefs, counts, backoff and clearance-presence for a seeded domain', () => {
    recordTlsImpersonationSuccess('promoted.test', 1); // flips prefer_tls_impersonation
    recordDomainClearance('promoted.test', {
      cookie: SEED_COOKIE,
      ua: SEED_UA,
      tier: 'tls',
      expiresAt: '2026-08-01T00:00:00.000Z',
    });
    recordBackoff('promoted.test', Date.now() + 60_000);

    const rows = listDomainRouting();
    const row = rows.find((r) => r.domain === 'promoted.test');
    expect(row).toBeDefined();
    expect(row!.preferTlsImpersonation).toBe(true);
    expect(row!.tlsSuccessCount).toBe(1);
    expect(row!.preferBrowser).toBe(false);
    expect(row!.clearancePresent).toBe(true);
    expect(row!.clearanceExpiresAt).toBe('2026-08-01T00:00:00.000Z');
    expect(typeof row!.backoffUntil).toBe('string');
    expect(row!.last403At).toBeTruthy();
  });

  it('reports clearancePresent=false and no expiry when no clearance is on file', () => {
    recordTlsImpersonationSuccess('nocred.test', 3);
    const row = listDomainRouting().find((r) => r.domain === 'nocred.test');
    expect(row).toBeDefined();
    expect(row!.clearancePresent).toBe(false);
    expect(row!.clearanceExpiresAt).toBeUndefined();
  });

  it('NEVER exposes the cf_clearance cookie value or the clearance UA (credential leak guard)', () => {
    recordDomainClearance('secret.test', {
      cookie: SEED_COOKIE,
      ua: SEED_UA,
      tier: 'browser',
      expiresAt: '2026-09-01T00:00:00.000Z',
    });
    const rows = listDomainRouting();
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(SEED_COOKIE);
    expect(serialized).not.toContain('SUPERSECRETcookievalue123');
    expect(serialized).not.toContain(SEED_UA);
    expect(serialized).not.toContain('SecretUA');
    // No implementation library name leaks into the machine projection either:
    // the browser-preference key must use capability language, not "playwright".
    expect(serialized).not.toMatch(/playwright/i);
    // The projection object must not carry the raw column names either.
    const row = rows.find((r) => r.domain === 'secret.test')!;
    expect(row).not.toHaveProperty('preferPlaywright');
    expect(row).not.toHaveProperty('cfClearance');
    expect(row).not.toHaveProperty('clearanceUa');
    expect(row).not.toHaveProperty('cf_clearance');
    expect(row).not.toHaveProperty('clearance_ua');
  });
});

describe('resetDomainRouting / resetAllDomainRouting', () => {
  beforeEach(() => { initDatabase(':memory:'); });
  afterEach(() => { closeDatabase(); });

  function seed(domain: string): void {
    recordTlsImpersonationSuccess(domain, 1); // prefer_tls_impersonation=1, tls_success_count=1
    getDatabase().prepare(
      'UPDATE domain_routing SET prefer_playwright = 1, http_failures = 7 WHERE domain = ?',
    ).run(domain);
    recordDomainClearance(domain, {
      cookie: SEED_COOKIE, ua: SEED_UA, tier: 'tls', expiresAt: '2026-08-01T00:00:00.000Z',
    });
    recordBackoff(domain, Date.now() + 60_000);
  }

  it('clears ALL routing/backoff/clearance fields for one domain and returns rowcount 1', () => {
    seed('reset.test');
    const changed = resetDomainRouting('reset.test');
    expect(changed).toBe(1);

    const routing = getDomainRouting('reset.test');
    expect(routing).not.toBeNull();
    expect(routing!.preferPlaywright).toBe(false);
    expect(routing!.preferTlsImpersonation).toBe(false);
    expect(routing!.tlsSuccessCount).toBe(0);
    expect(routing!.httpFailures).toBe(0);
    expect(getDomainClearance('reset.test')).toBeNull();
    expect(getBackoff('reset.test')).toBeNull();

    // last_403_at is write-only in the routing pipeline; assert it too clears.
    const raw = getDatabase().prepare(
      'SELECT last_403_at FROM domain_routing WHERE domain = ?',
    ).get('reset.test') as { last_403_at: string | null };
    expect(raw.last_403_at).toBeNull();
  });

  it('returns rowcount 0 for an unknown domain and touches nothing', () => {
    seed('keep.test');
    const changed = resetDomainRouting('does-not-exist.test');
    expect(changed).toBe(0);
    // Untouched domain still fully populated.
    expect(getDomainRouting('keep.test')!.preferTlsImpersonation).toBe(true);
    expect(getDomainClearance('keep.test')).not.toBeNull();
  });

  it('resetDomainRouting leaves OTHER domains untouched', () => {
    seed('a.test');
    seed('b.test');
    resetDomainRouting('a.test');
    expect(getDomainClearance('a.test')).toBeNull();
    expect(getDomainRouting('a.test')!.preferTlsImpersonation).toBe(false);
    // b is fully intact.
    expect(getDomainClearance('b.test')).not.toBeNull();
    expect(getDomainRouting('b.test')!.preferTlsImpersonation).toBe(true);
    expect(getBackoff('b.test')).not.toBeNull();
  });

  it('resetAllDomainRouting clears every domain and returns the total rowcount', () => {
    seed('one.test');
    seed('two.test');
    seed('three.test');
    const changed = resetAllDomainRouting();
    expect(changed).toBe(3);
    for (const d of ['one.test', 'two.test', 'three.test']) {
      expect(getDomainClearance(d)).toBeNull();
      expect(getBackoff(d)).toBeNull();
      expect(getDomainRouting(d)!.preferTlsImpersonation).toBe(false);
    }
  });

  it('throws (does not swallow) when the database is unavailable', () => {
    seed('boom.test');
    closeDatabase();
    // No open DB — the store must surface the failure, not silently no-op.
    expect(() => resetDomainRouting('boom.test')).toThrow();
    expect(() => resetAllDomainRouting()).toThrow();
    // Re-open so afterEach's closeDatabase() is a clean no-op-safe close.
    initDatabase(':memory:');
  });
});
