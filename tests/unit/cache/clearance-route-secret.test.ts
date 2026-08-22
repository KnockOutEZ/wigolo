import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDatabase, closeDatabase, getDatabase } from '../../../src/cache/db.js';
import { _resetMigrationGuard } from '../../../src/cache/migrations/runner.js';
import { getDomainClearance, recordDomainClearance } from '../../../src/cache/store.js';
import { routeMatchesClearance, normalizeClearanceRoute } from '../../../src/fetch/clearance-reuse.js';

/**
 * `solvedRoute` is written as `getConfig().proxyUrl ?? 'direct'`, and proxyUrl
 * is resolved through resolveCredentialUrl — so it can carry inline
 * `user:pass@`. Persisting it verbatim wrote those credentials into the cache
 * DB in cleartext, where they survive across runs. persisted-config.ts already
 * treats credential-bearing URLs as secrets that must never reach disk in
 * cleartext; this contradicted that posture.
 *
 * The gate only needs EQUALITY of the egress route, never the original string.
 */
const CRED_PROXY = 'http://alice:hunter2@proxy.example.com:8080';

describe('a clearance never persists proxy credentials', () => {
  let dir: string;

  beforeEach(() => {
    _resetMigrationGuard();
    dir = mkdtempSync(join(tmpdir(), 'wigolo-route-secret-'));
    initDatabase(join(dir, 'cache.db'));
  });
  afterEach(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });

  function record(route: string) {
    recordDomainClearance('example.com', {
      cookie: 'cf_clearance=TOKEN',
      ua: 'Mozilla/5.0 Chrome/142.0.0.0',
      tier: 'browser',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      solvedRoute: route,
    });
  }

  it('strips userinfo before the value reaches the database', () => {
    record(CRED_PROXY);
    const raw = getDatabase()
      .prepare('SELECT solved_route FROM domain_routing WHERE domain = ?')
      .get('example.com') as { solved_route: string };

    expect(raw.solved_route).not.toContain('hunter2');
    expect(raw.solved_route).not.toContain('alice');
    expect(raw.solved_route).toContain('proxy.example.com');
  });

  it('keeps the route distinguishable — different proxies must not collide', () => {
    record(CRED_PROXY);
    const a = getDomainClearance('example.com')!.solvedRoute;
    record('http://bob:pw@other.example.com:8080');
    const b = getDomainClearance('example.com')!.solvedRoute;
    expect(a).not.toBe(b);
  });

  it('still matches the SAME proxy computed from the credential-bearing config', () => {
    // The mint side stores the stripped identity; the compare side derives the
    // current route from the raw configured proxyUrl. They must agree, or reuse
    // silently dies for every proxy user.
    record(CRED_PROXY);
    const stored = getDomainClearance('example.com')!;
    expect(routeMatchesClearance(stored.solvedRoute, CRED_PROXY)).toBe(true);
  });

  it('does NOT match a different proxy', () => {
    record(CRED_PROXY);
    const stored = getDomainClearance('example.com')!;
    expect(routeMatchesClearance(stored.solvedRoute, 'http://elsewhere.example:3128')).toBe(false);
  });

  it('leaves the direct route alone', () => {
    record('direct');
    expect(getDomainClearance('example.com')!.solvedRoute).toBe('direct');
    expect(routeMatchesClearance('direct', 'direct')).toBe(true);
  });

  it('normalizes both sides of the comparison identically', () => {
    expect(normalizeClearanceRoute(CRED_PROXY)).toBe(
      normalizeClearanceRoute('http://proxy.example.com:8080'),
    );
  });
});
