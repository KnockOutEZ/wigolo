import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, getDatabase, initDatabase } from '../../../src/cache/db.js';
import {
  LIST_VERSIONED_URLS_SQL,
  listVersionedUrls,
} from '../../../src/cache/version-read.js';

function insertVersion(url: string, hash: string, fetchedAt: string): void {
  getDatabase().prepare(`
    INSERT INTO url_versions (
      normalized_url, content_hash, markdown, title, http_status, fetched_at, byte_len
    ) VALUES (?, ?, ?, ?, 200, ?, ?)
  `).run(url, hash, `body ${hash}`, hash, fetchedAt, hash.length + 5);
}

describe('listVersionedUrls', () => {
  beforeEach(() => initDatabase(':memory:'));
  afterEach(() => closeDatabase());

  it('enumerates per-URL counts and bounds with cursor pagination', () => {
    insertVersion('https://a.example', 'a1', '2026-08-01 00:00:00');
    insertVersion('https://a.example', 'a2', '2026-08-03 00:00:00');
    insertVersion('https://b.example', 'b1', '2026-08-02 00:00:00');
    insertVersion('https://c.example', 'c1', '2026-08-04 00:00:00');

    const first = listVersionedUrls({ limit: 2 });
    expect(first).toEqual({
      rows: [
        {
          normalized_url: 'https://a.example',
          versions: 2,
          newest: '2026-08-03 00:00:00',
          oldest: '2026-08-01 00:00:00',
        },
        {
          normalized_url: 'https://b.example',
          versions: 1,
          newest: '2026-08-02 00:00:00',
          oldest: '2026-08-02 00:00:00',
        },
      ],
      next_cursor: 'https://b.example',
    });
    expect(listVersionedUrls({ cursor: first.next_cursor ?? undefined, limit: 2 })).toEqual({
      rows: [{
        normalized_url: 'https://c.example',
        versions: 1,
        newest: '2026-08-04 00:00:00',
        oldest: '2026-08-04 00:00:00',
      }],
      next_cursor: null,
    });
  });

  it('uses the covering URL/time index for corpus enumeration', () => {
    const plan = getDatabase()
      .prepare(`EXPLAIN QUERY PLAN ${LIST_VERSIONED_URLS_SQL}`)
      .all('', 21) as Array<{ detail: string }>;
    const detail = plan.map((row) => row.detail).join(' | ');

    expect(detail).toMatch(/USING COVERING INDEX idx_url_versions_url_time/);
    expect(detail).not.toMatch(/SCAN url_versions/);
    expect(detail).not.toMatch(/USE TEMP B-TREE/);
  });
});
