import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDatabase, closeDatabase, getDatabase } from '../../../src/cache/db.js';
import { _resetMigrationGuard } from '../../../src/cache/migrations/runner.js';
import {
  recordDomainClearance,
  recordClearanceReuse,
  listDomainClearances,
  deleteDomainClearance,
  getDomainClearance,
  clearDomainClearance,
} from '../../../src/cache/store.js';
import type { DomainClearanceRecord } from '../../../src/cache/store.js';

/**
 * SD6 §10 — the clearance reuse ledger. Core already knew a wall had been solved; it did
 * not know whether that solve went on to save anything. These rows are what the site
 * profile card states as "solved this wall 2026-08-12 · reused 14x", and what the privacy
 * dashboard deletes.
 *
 * The load-bearing property is what the read CANNOT carry: a per-host clearance is only
 * showable in a dashboard because the projection has no field a cookie could occupy.
 */

/**
 * A value distinctive enough that finding it anywhere in a serialised projection is proof
 * of a leak rather than a coincidence.
 */
const SECRET = 'cf_clearance=SUPER-SECRET-CLEARANCE-TOKEN-7f3a';
const SECRET_VALUE = 'SUPER-SECRET-CLEARANCE-TOKEN-7f3a';
const MINTING_UA = 'Mozilla/5.0 Chrome/142.0.0.0 Safari/537.36';

function solve(host: string, route = 'direct'): void {
  recordDomainClearance(host, {
    cookie: SECRET,
    ua: MINTING_UA,
    tier: 'browser',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    solvedRoute: route,
  });
}

function rowFor(host: string): DomainClearanceRecord {
  const found = listDomainClearances().find((r) => r.host === host);
  if (!found) throw new Error(`no clearance record for ${host}`);
  return found;
}

describe('clearance reuse ledger', () => {
  let dir: string;

  beforeEach(() => {
    _resetMigrationGuard();
    dir = mkdtempSync(join(tmpdir(), 'wigolo-clearance-ledger-'));
    initDatabase(join(dir, 'cache.db'));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('bump on reuse', () => {
    it('counts each replay of the current clearance', () => {
      solve('walled.example');
      expect(rowFor('walled.example').reusedCount).toBe(0);
      expect(rowFor('walled.example').lastReusedAt).toBeUndefined();

      recordClearanceReuse('walled.example');
      recordClearanceReuse('walled.example');
      recordClearanceReuse('walled.example');

      const row = rowFor('walled.example');
      expect(row.reusedCount).toBe(3);
      expect(row.lastReusedAt).toBeTruthy();
    });

    it('bumps only the host asked for', () => {
      solve('a.example');
      solve('b.example');
      recordClearanceReuse('a.example');

      expect(rowFor('a.example').reusedCount).toBe(1);
      expect(rowFor('b.example').reusedCount).toBe(0);
    });

    /**
     * A reuse can only be counted against a clearance that exists. Without the
     * `cf_clearance IS NOT NULL` guard a bump racing a purge would leave a routing row
     * claiming replays of a cookie that is gone.
     */
    it('does not count a reuse for a host with no clearance', () => {
      solve('purged.example');
      clearDomainClearance('purged.example');
      recordClearanceReuse('purged.example');

      const db = getDatabase();
      const row = db.prepare(
        'SELECT reused_count, last_reused_at FROM domain_routing WHERE domain = ?',
      ).get('purged.example') as { reused_count: number; last_reused_at: string | null };
      expect(row.reused_count).toBe(0);
      expect(row.last_reused_at).toBeNull();
    });

    it('is a silent no-op for an untracked host', () => {
      expect(() => recordClearanceReuse('never-seen.example')).not.toThrow();
      expect(listDomainClearances()).toHaveLength(0);
    });

    /**
     * The tally belongs to ONE clearance, not to the host: a card reading
     * "solved <date> · reused N x" would be a lie if N counted replays of a cookie that
     * is no longer the one being described.
     */
    it('restarts the tally on a fresh solve', () => {
      solve('resolved.example');
      recordClearanceReuse('resolved.example');
      recordClearanceReuse('resolved.example');
      expect(rowFor('resolved.example').reusedCount).toBe(2);

      solve('resolved.example');

      const row = rowFor('resolved.example');
      expect(row.reusedCount).toBe(0);
      expect(row.lastReusedAt).toBeUndefined();
    });

    it('drops the tally when the clearance is purged as stale', () => {
      solve('stale.example');
      recordClearanceReuse('stale.example');
      clearDomainClearance('stale.example');

      expect(listDomainClearances().find((r) => r.host === 'stale.example')).toBeUndefined();
    });
  });

  describe('value-free read', () => {
    it('reports the ledger fields for a solved host', () => {
      solve('ledger.example', 'http://proxy.example.com:8080');
      recordClearanceReuse('ledger.example');

      const row = rowFor('ledger.example');
      expect(row.host).toBe('ledger.example');
      expect(row.solvedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      expect(row.reusedCount).toBe(1);
      expect(row.route).toBe('http://proxy.example.com:8080');
    });

    /**
     * The runtime half of the no-value-field construction. The type half is
     * `ClearanceRecordCarriesNoSecret` in the store itself — it fails to COMPILE if a
     * cookie- or UA-shaped field is ever added to the record, and it lives in `src/`
     * because `tsconfig.test.json` type-checks an allowlist that this file is not on.
     * This one fails if a value reaches a caller some other way.
     */
    it('carries neither the cookie nor the minting user-agent', () => {
      solve('secret.example');
      const rows = listDomainClearances();
      const serialised = JSON.stringify(rows);

      expect(serialised).not.toContain(SECRET_VALUE);
      expect(serialised).not.toContain(MINTING_UA);
      expect(Object.keys(rows[0]).sort()).toEqual([
        'host',
        'lastReusedAt',
        'reusedCount',
        'route',
        'solvedAt',
      ]);
    });

    it('omits hosts that hold no clearance', () => {
      solve('has.example');
      recordDomainClearance('gone.example', {
        cookie: SECRET,
        ua: MINTING_UA,
        tier: 'browser',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
      clearDomainClearance('gone.example');

      expect(listDomainClearances().map((r) => r.host)).toEqual(['has.example']);
    });

    it('orders newest solve first', () => {
      const db = getDatabase();
      solve('older.example');
      db.prepare("UPDATE domain_routing SET clearance_solved_at = '2020-01-01T00:00:00Z' WHERE domain = ?")
        .run('older.example');
      solve('newer.example');

      expect(listDomainClearances().map((r) => r.host)).toEqual(['newer.example', 'older.example']);
    });

    /**
     * Rows solved before migration 020 carry no solve stamp. They still have to render,
     * so the projection resolves the gap to `last_updated` — the closest instant the row
     * holds — rather than emitting an empty date onto a card.
     */
    it('falls back to last_updated for a pre-020 row', () => {
      solve('legacy.example');
      getDatabase()
        .prepare('UPDATE domain_routing SET clearance_solved_at = NULL WHERE domain = ?')
        .run('legacy.example');

      expect(rowFor('legacy.example').solvedAt).toBeTruthy();
    });

    /** Same rule as getDomainClearance's: one NULL-route reading for one column. */
    it('reads a legacy NULL route back as direct', () => {
      solve('legacy-route.example');
      getDatabase()
        .prepare('UPDATE domain_routing SET solved_route = NULL WHERE domain = ?')
        .run('legacy-route.example');

      expect(rowFor('legacy-route.example').route).toBe('direct');
    });
  });

  describe('delete by host', () => {
    it('forgets the clearance and its tally', () => {
      solve('forget.example');
      recordClearanceReuse('forget.example');

      expect(deleteDomainClearance('forget.example')).toBe(1);
      expect(listDomainClearances()).toHaveLength(0);
      expect(getDomainClearance('forget.example')).toBeNull();
    });

    /**
     * Deleting a solved wall is not the same request as un-learning which engine serves
     * the host: the routing row survives with its preferences intact.
     */
    it('keeps the learned routing preference', () => {
      solve('keep-routing.example');
      const db = getDatabase();
      db.prepare('UPDATE domain_routing SET prefer_playwright = 1 WHERE domain = ?')
        .run('keep-routing.example');

      deleteDomainClearance('keep-routing.example');

      const row = db.prepare('SELECT prefer_playwright FROM domain_routing WHERE domain = ?')
        .get('keep-routing.example') as { prefer_playwright: number };
      expect(row.prefer_playwright).toBe(1);
    });

    it('reports 0 for an untracked host', () => {
      expect(deleteDomainClearance('untracked.example')).toBe(0);
    });

    it('leaves other hosts alone', () => {
      solve('keep.example');
      solve('drop.example');

      deleteDomainClearance('drop.example');

      expect(listDomainClearances().map((r) => r.host)).toEqual(['keep.example']);
    });
  });

  /** AC: the UA / freshness / route gating this issue rides on must not have moved. */
  describe('existing clearance reads are unchanged', () => {
    it('still returns the cookie, ua, tier, expiry and route to the fetch tier', () => {
      const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
      recordDomainClearance('gate.example', {
        cookie: SECRET,
        ua: MINTING_UA,
        tier: 'browser',
        expiresAt,
        solvedRoute: 'http://alice:hunter2@proxy.example.com:8080',
      });

      expect(getDomainClearance('gate.example')).toEqual({
        cookie: SECRET,
        ua: MINTING_UA,
        tier: 'browser',
        expiresAt,
        solvedRoute: 'http://proxy.example.com:8080',
      });
    });
  });
});
