import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDatabase, closeDatabase } from '../../../src/cache/db.js';
import { _resetMigrationGuard } from '../../../src/cache/migrations/runner.js';
import { recordDomainClearance, listDomainClearances } from '../../../src/cache/store.js';
import {
  parsedClearanceCookie,
  isClearanceReusable,
  clearanceCookieValue,
} from '../../../src/fetch/clearance-reuse.js';
import { resolveStealthUA } from '../../../src/fetch/stealth.js';
import type { DomainClearance } from '../../../src/cache/store.js';

/**
 * SD6 §10 — where a clearance reuse is COUNTED.
 *
 * `parsedClearanceCookie` is the browser tier's consumption seam: the router calls it once
 * per replay, after every gate has passed, and injects what it returns. Counting anywhere
 * earlier counts refusals as reuses, and the ledger card ("reused 14x") would overstate
 * what the solve saved.
 */

const COOKIE = 'cf_clearance=tok-abc';
const HOST = 'walled.example';

describe('clearance reuse bump — the consumption seam', () => {
  it('counts one reuse, for the host the cookie is scoped to', () => {
    const seen: string[] = [];
    const cookie = parsedClearanceCookie(COOKIE, HOST, (h) => seen.push(h));

    expect(cookie).toEqual({ name: 'cf_clearance', value: 'tok-abc', domain: HOST, path: '/' });
    expect(seen).toEqual([HOST]);
  });

  it('counts nothing when no clearance cookie comes out', () => {
    const seen: string[] = [];
    expect(parsedClearanceCookie('session=1', HOST, (h) => seen.push(h))).toBeNull();
    expect(seen).toEqual([]);
  });

  /**
   * The predicate is asked before EVERY attempt, including the ones it refuses. If it
   * counted, a host whose clearance is stale or route-mismatched would accrue reuses it
   * never got — so its purity is the property, not an accident.
   */
  it('the eligibility predicate does not count anything', () => {
    const fresh: DomainClearance = {
      cookie: COOKIE,
      ua: resolveStealthUA(),
      tier: 'browser',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      solvedRoute: 'direct',
    };
    const before = clearanceCookieValue(fresh.cookie);
    expect(isClearanceReusable(fresh, 'browser', 'direct', Date.now())).toBe(true);
    // Nothing observable changed: the predicate reads, it does not write.
    expect(clearanceCookieValue(fresh.cookie)).toBe(before);
  });

  /** No cache DB open (the pure-helper case): the default writer must not conjure one. */
  it('the default writer is a silent no-op without an open cache DB', () => {
    expect(() => parsedClearanceCookie(COOKIE, HOST)).not.toThrow();
  });
});

describe('clearance reuse bump — against the real ledger', () => {
  let dir: string;

  beforeEach(() => {
    _resetMigrationGuard();
    dir = mkdtempSync(join(tmpdir(), 'wigolo-clearance-bump-'));
    initDatabase(join(dir, 'cache.db'));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * The production wiring, with NO injected writer — the router passes two arguments, so
   * this is the arm that proves the counter moves in a real process rather than only when
   * a test hands the seam a spy.
   */
  it('three replays through the seam leave reused_count at 3', () => {
    recordDomainClearance(HOST, {
      cookie: COOKIE,
      ua: resolveStealthUA(),
      tier: 'browser',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      solvedRoute: 'direct',
    });

    for (let i = 0; i < 3; i++) {
      expect(parsedClearanceCookie(COOKIE, HOST)).not.toBeNull();
    }

    const row = listDomainClearances().find((r) => r.host === HOST);
    expect(row?.reusedCount).toBe(3);
    expect(row?.lastReusedAt).toBeTruthy();
  });
});
