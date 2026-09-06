import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, getDatabase, initDatabase } from 'wigolo/cache/db';
import { deleteDomainClearance, listDomainClearances } from 'wigolo/cache';
import type { DomainClearanceRecord } from 'wigolo/cache';

describe('wigolo/cache clearance ledger boundary', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wigolo-cache-subpath-clearance-'));
    initDatabase(join(dir, 'cache.db'));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads and deletes a seeded clearance through the published subpath', () => {
    const secret = 'cf_clearance=must-not-leave-the-store';
    getDatabase().prepare(`
      INSERT INTO domain_routing (
        domain, cf_clearance, clearance_ua, clearance_tier, clearance_expires_at,
        clearance_solved_at, reused_count, last_reused_at, solved_route, last_updated
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'protected.example',
      secret,
      'test-user-agent',
      'browser',
      '2026-09-07T00:00:00.000Z',
      '2026-09-06T12:00:00.000Z',
      3,
      '2026-09-06T12:30:00.000Z',
      'direct',
      '2026-09-06T12:30:00.000Z',
    );

    const records: DomainClearanceRecord[] = listDomainClearances();
    expect(records).toEqual([{
      host: 'protected.example',
      solvedAt: '2026-09-06T12:00:00.000Z',
      reusedCount: 3,
      lastReusedAt: '2026-09-06T12:30:00.000Z',
      route: 'direct',
    }]);
    expect(JSON.stringify(records)).not.toContain(secret);

    expect(deleteDomainClearance('protected.example')).toBe(1);
    expect(listDomainClearances()).toEqual([]);
  });
});
