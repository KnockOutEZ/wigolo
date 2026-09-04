import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * The semantic leg is stubbed OFF for this suite.
 *
 * Everything here is the FTS/retention contract, and `searchVisits` now degrades
 * to exactly that shape when the vector side is unavailable — which is what a
 * rejected `getVectorStore()` produces. Stubbing it is not avoidance: an
 * unstubbed call would warm a real embedding model in a unit suite, and the
 * semantic behaviour has its own suite (`visits-semantic.test.ts`) where the
 * vectors are real.
 */
vi.mock('../../../src/providers/vector-store.js', () => ({
  getVectorStore: vi.fn(async () => {
    throw new Error('vector store unavailable in this suite');
  }),
}));

const { initDatabase, closeDatabase, getDatabase } = await import('../../../src/cache/db.js');
const {
  VISIT_RETENTION_DEFAULTS,
  deleteVisits,
  isSiteCaptureEnabled,
  listVisits,
  readVisitPage,
  recordVisit,
  searchVisits,
  setSiteCapture,
} = await import('../../../src/cache/visit-store.js');
import type { VisitRetentionBounds } from '../../../src/cache/visit-store.js';

/**
 * SD7 A-18-5/A-18-6 — the visits store.
 *
 * This is history-with-content: what the human actually read, searchable offline, and
 * partitioned from every agent-facing corpus (that half is asserted in
 * `visits-agent-partition.test.ts`). What is encoded here is the WHY of each rule:
 *
 * - one body per content hash, because a human re-reading the same unchanged page 50 times
 *   must cost one body, not 50;
 * - a visit row survives the loss of its body, because the record of having read a page is
 *   history in its own right and the byte bound has to be able to bind on the bodies alone;
 * - bounds are proven by FORCING growth, never by observing that a bound did not happen to
 *   bind — the program has twice paid a 45 GB disk bill for an unbounded writer;
 * - disable ≠ purge: turning capture off says "stop recording", not "destroy my history",
 *   and the two are different consents (the same asymmetry `version-store.ts` documents).
 */

const TINY: VisitRetentionBounds = { maxVisits: 100, maxBytes: 1024 * 1024, maxAgeDays: 365 };

function visit(overrides: Partial<Parameters<typeof recordVisit>[0]> = {}) {
  return recordVisit({
    url: 'https://example.com/a',
    title: 'Page A',
    ts: '2026-09-03 10:00:00',
    tabId: 'tab-1',
    markdown: 'quokka telemetry ledger notes',
    retention: TINY,
    ...overrides,
  });
}

function visitCount(): number {
  return (getDatabase().prepare('SELECT COUNT(*) AS n FROM studio_visits').get() as { n: number }).n;
}

function bodyCount(): number {
  return (getDatabase().prepare('SELECT COUNT(*) AS n FROM studio_visit_pages').get() as { n: number }).n;
}

describe('visit store — recordVisit', () => {
  beforeEach(() => {
    initDatabase(':memory:');
  });
  afterEach(() => {
    closeDatabase();
  });

  it('records the visit and its body, keeping the visit its own full URL', () => {
    const out = visit({ url: 'https://www.example.com/a?utm_source=x&q=1' });
    expect(out.stored).toBe(true);
    const row = getDatabase().prepare('SELECT * FROM studio_visits').get() as Record<string, unknown>;
    // The full URL is what history is FOR; the normalized one is what the site filter seeks on.
    expect(row.url).toBe('https://www.example.com/a?utm_source=x&q=1');
    expect(row.normalized_url).toBe('https://example.com/a?q=1');
    expect(row.title).toBe('Page A');
    expect(row.tab_id).toBe('tab-1');
    expect(row.space_id).toBe('default');
    expect(row.run_id).toBeNull();
    expect(typeof row.content_hash).toBe('string');
    expect(readVisitPage(row.content_hash as string)?.markdown).toBe('quokka telemetry ledger notes');
  });

  it('stores one body for two visits to the same unchanged page', () => {
    visit({ ts: '2026-09-03 10:00:00' });
    visit({ ts: '2026-09-03 11:00:00' });
    expect(visitCount()).toBe(2);
    // The dedup is structural (the hash is the primary key), not a caller's discipline.
    expect(bodyCount()).toBe(1);
  });

  it('records a metadata-only visit when no body was captured', () => {
    const out = visit({ markdown: null });
    expect(out.stored).toBe(true);
    expect(visitCount()).toBe(1);
    expect(bodyCount()).toBe(0);
    const row = getDatabase().prepare('SELECT content_hash FROM studio_visits').get() as {
      content_hash: string | null;
    };
    expect(row.content_hash).toBeNull();
  });

  it('carries run attribution when the tab belongs to a run (law 4)', () => {
    visit({ runId: 'run-7' });
    const row = getDatabase().prepare('SELECT run_id FROM studio_visits').get() as { run_id: string | null };
    expect(row.run_id).toBe('run-7');
  });

  it('refuses a body that alone exceeds the whole byte budget, and still keeps the visit', () => {
    const out = visit({
      markdown: 'x'.repeat(2048),
      retention: { ...TINY, maxBytes: 1024 },
    });
    // Refused BEFORE the insert: an inserted-then-swept body has already raised the database
    // file's high-water mark, and db.ts sets no auto_vacuum.
    expect(out.stored).toBe(true);
    expect(out.bodyStored).toBe(false);
    expect(visitCount()).toBe(1);
    expect(bodyCount()).toBe(0);
  });

  it('never throws when the visit is unrecordable — history must not fail a navigation', () => {
    getDatabase().exec('DROP TABLE studio_visits');
    expect(() => visit()).not.toThrow();
    expect(visit().stored).toBe(false);
  });
});

describe('visit store — per-site capture-off (3bf)', () => {
  beforeEach(() => {
    initDatabase(':memory:');
  });
  afterEach(() => {
    closeDatabase();
  });

  it('captures a host nobody has ruled on — an absent decision is not an opt-out', () => {
    expect(isSiteCaptureEnabled('example.com')).toBe(true);
    expect(visit().stored).toBe(true);
  });

  it('records nothing for a host whose capture is off, and says why', () => {
    setSiteCapture('example.com', false);
    const out = visit();
    expect(out.stored).toBe(false);
    expect(out.reason).toBe('capture_off');
    expect(visitCount()).toBe(0);
  });

  it('keys the decision on the normalized host, so www and a port do not escape it', () => {
    setSiteCapture('WWW.Example.com', false);
    expect(isSiteCaptureEnabled('example.com')).toBe(false);
    expect(visit({ url: 'https://www.example.com/b' }).stored).toBe(false);
    expect(visit({ url: 'https://example.com:8443/b' }).stored).toBe(false);
    // A different host is unaffected — the toggle is per site, not global.
    expect(visit({ url: 'https://other.example.org/b' }).stored).toBe(true);
  });

  it('turning capture off does NOT purge what is already recorded (disable ≠ purge)', () => {
    visit();
    setSiteCapture('example.com', false);
    expect(visitCount()).toBe(1);
    expect(bodyCount()).toBe(1);
    // Re-enabling resumes recording without needing the history back.
    setSiteCapture('example.com', true);
    expect(visit({ ts: '2026-09-03 12:00:00' }).stored).toBe(true);
    expect(visitCount()).toBe(2);
  });
});

describe('visit store — searchVisits (FTS)', () => {
  beforeEach(() => {
    initDatabase(':memory:');
    visit({ url: 'https://example.com/a', title: 'A', markdown: 'quokka telemetry ledger notes' });
    visit({
      url: 'https://other.org/b',
      title: 'B',
      ts: '2026-09-03 09:00:00',
      markdown: 'wombat pricing tiers and quotas',
    });
  });
  afterEach(() => {
    closeDatabase();
  });

  it('finds a visit by text that only its stored body carries', async () => {
    const { results, method } = await searchVisits({ query: 'quokka' });
    expect(results.map((h) => h.url)).toEqual(['https://example.com/a']);
    expect(results[0].title).toBe('A');
    expect(results[0].snippet).toContain('quokka');
    // With no vector side reachable the search says so rather than implying it
    // searched by meaning and found nothing.
    expect(method).toBe('fts');
  });

  it('returns nothing for a term no stored body carries', async () => {
    expect((await searchVisits({ query: 'badger' })).results).toEqual([]);
  });

  it('scopes to one site when asked', async () => {
    const { results } = await searchVisits({ query: 'quokka OR wombat', site: 'other.org' });
    expect(results.map((h) => h.url)).toEqual(['https://other.org/b']);
  });

  it('survives a hostile query instead of throwing FTS syntax at the caller', async () => {
    for (const query of ['"unclosed', 'a AND (', '*', '']) {
      await expect(searchVisits({ query })).resolves.toBeDefined();
    }
  });

  it('honours limit', async () => {
    expect((await searchVisits({ query: 'quokka OR wombat', limit: 1 })).results).toHaveLength(1);
  });

  it('surfaces every visit that shares one deduped body', async () => {
    visit({ url: 'https://example.com/a', ts: '2026-09-03 14:00:00' });
    // Two visits, one body: search is over visits, so both rows come back.
    const { results } = await searchVisits({ query: 'quokka' });
    expect(results).toHaveLength(2);
    expect(new Set(results.map((h) => h.contentHash)).size).toBe(1);
  });
});

describe('visit store — listVisits (cursor)', () => {
  beforeEach(() => {
    initDatabase(':memory:');
    for (let i = 1; i <= 5; i += 1) {
      visit({ url: `https://example.com/p${i}`, ts: `2026-09-0${i} 10:00:00`, title: `P${i}` });
    }
  });
  afterEach(() => {
    closeDatabase();
  });

  it('pages newest-first with no overlap and no gap', () => {
    const first = listVisits({ limit: 2 });
    expect(first.rows.map((r) => r.title)).toEqual(['P5', 'P4']);
    expect(first.next_cursor).toBeTruthy();

    const second = listVisits({ limit: 2, cursor: first.next_cursor! });
    expect(second.rows.map((r) => r.title)).toEqual(['P3', 'P2']);

    const third = listVisits({ limit: 2, cursor: second.next_cursor! });
    expect(third.rows.map((r) => r.title)).toEqual(['P1']);
    expect(third.next_cursor).toBeNull();
  });

  it('separates two visits sharing one timestamp by id, so neither is skipped', () => {
    initDatabase(':memory:');
    visit({ url: 'https://example.com/x', ts: '2026-09-03 10:00:00', title: 'X' });
    visit({ url: 'https://example.com/y', ts: '2026-09-03 10:00:00', title: 'Y' });
    const first = listVisits({ limit: 1 });
    expect(first.rows[0].title).toBe('Y');
    const second = listVisits({ limit: 1, cursor: first.next_cursor! });
    expect(second.rows[0].title).toBe('X');
  });

  it('filters to one site and to one UTC day', () => {
    visit({ url: 'https://other.org/z', ts: '2026-09-03 23:59:59', title: 'Z' });
    expect(listVisits({ site: 'other.org' }).rows.map((r) => r.title)).toEqual(['Z']);
    expect(listVisits({ day: '2026-09-03' }).rows.map((r) => r.title).sort()).toEqual(['P3', 'Z']);
  });

  it('rejects a malformed cursor rather than silently restarting the page', () => {
    expect(() => listVisits({ cursor: 'not-a-cursor' })).toThrow(/invalid visit cursor/);
  });
});

describe('visit store — deleteVisits (3bf per-site and per-day controls)', () => {
  beforeEach(() => {
    initDatabase(':memory:');
  });
  afterEach(() => {
    closeDatabase();
  });

  it('deletes one site, including its www and port forms, and leaves other sites alone', () => {
    visit({ url: 'https://www.example.com/a', markdown: 'aaa aaa' });
    visit({ url: 'https://example.com:8443/b', markdown: 'bbb bbb' });
    visit({ url: 'http://example.com/c', markdown: 'ccc ccc' });
    visit({ url: 'https://other.org/d', markdown: 'ddd ddd' });
    // A near-miss host that must NOT match: a prefix of the target is a different site.
    visit({ url: 'https://example.com.evil.test/e', markdown: 'eee eee' });

    const removed = deleteVisits({ site: 'example.com' });
    expect(removed.visits).toBe(3);
    expect(
      listVisits({})
        .rows.map((r) => r.url)
        .sort(),
    ).toEqual(['https://example.com.evil.test/e', 'https://other.org/d']);
    // Their bodies go with them — a "clear this site" that leaves full page text behind is the
    // class of defect `deleteVersionsForUrls` exists to close.
    expect(removed.bodies).toBe(3);
    expect(bodyCount()).toBe(2);
  });

  it('keeps a body that a surviving visit still references', () => {
    visit({ url: 'https://example.com/a', markdown: 'shared body text' });
    visit({ url: 'https://other.org/a', markdown: 'shared body text' });
    expect(bodyCount()).toBe(1);
    const removed = deleteVisits({ site: 'example.com' });
    expect(removed.visits).toBe(1);
    expect(removed.bodies).toBe(0);
    expect(bodyCount()).toBe(1);
  });

  it('deletes exactly one UTC day', () => {
    visit({ url: 'https://example.com/a', ts: '2026-09-02 23:59:59', markdown: 'aaa aaa' });
    visit({ url: 'https://example.com/b', ts: '2026-09-03 00:00:00', markdown: 'bbb bbb' });
    visit({ url: 'https://example.com/c', ts: '2026-09-03 23:59:59', markdown: 'ccc ccc' });
    visit({ url: 'https://example.com/d', ts: '2026-09-04 00:00:00', markdown: 'ddd ddd' });

    const removed = deleteVisits({ day: '2026-09-03' });
    expect(removed.visits).toBe(2);
    expect(
      listVisits({})
        .rows.map((r) => r.url)
        .sort(),
    ).toEqual(['https://example.com/a', 'https://example.com/d']);
  });

  it('deletes the intersection when a site and a day are both given', () => {
    visit({ url: 'https://example.com/a', ts: '2026-09-03 10:00:00', markdown: 'aaa aaa' });
    visit({ url: 'https://other.org/b', ts: '2026-09-03 10:00:00', markdown: 'bbb bbb' });
    visit({ url: 'https://example.com/c', ts: '2026-09-04 10:00:00', markdown: 'ccc ccc' });
    expect(deleteVisits({ site: 'example.com', day: '2026-09-03' }).visits).toBe(1);
    expect(listVisits({}).rows).toHaveLength(2);
  });

  it('refuses a delete with no scope rather than wiping all history', () => {
    visit();
    expect(() => deleteVisits({})).toThrow(/scope/i);
    expect(visitCount()).toBe(1);
  });

  it('drops deleted bodies out of the visits FTS index', async () => {
    visit({ markdown: 'quokka telemetry ledger notes' });
    expect((await searchVisits({ query: 'quokka' })).results).toHaveLength(1);
    deleteVisits({ site: 'example.com' });
    // Not merely unlinked: the index row is gone, so a later search cannot resurrect the text.
    expect((await searchVisits({ query: 'quokka' })).results).toEqual([]);
    const indexed = getDatabase()
      .prepare(`SELECT COUNT(*) AS n FROM studio_visit_pages_fts WHERE studio_visit_pages_fts MATCH 'quokka'`)
      .get() as { n: number };
    expect(indexed.n).toBe(0);
  });

  it('rejects a day that is not a UTC calendar day', () => {
    expect(() => deleteVisits({ day: '2026-9-3' })).toThrow(/day/i);
    expect(() => deleteVisits({ day: "2026-09-03' OR 1=1 --" })).toThrow(/day/i);
  });
});

describe('visit store — retention bounds', () => {
  beforeEach(() => {
    initDatabase(':memory:');
  });
  afterEach(() => {
    closeDatabase();
  });

  it('documents its own defaults, and they are visits-shaped rather than url_versions-shaped', () => {
    expect(VISIT_RETENTION_DEFAULTS.maxVisits).toBeGreaterThan(0);
    expect(VISIT_RETENTION_DEFAULTS.maxBytes).toBeGreaterThan(0);
    expect(VISIT_RETENTION_DEFAULTS.maxAgeDays).toBeGreaterThan(0);
  });

  it('evicts the oldest visits once the row bound binds', () => {
    const bounds = { ...TINY, maxVisits: 3 };
    for (let i = 1; i <= 5; i += 1) {
      visit({
        url: `https://example.com/p${i}`,
        ts: `2026-09-0${i} 10:00:00`,
        title: `P${i}`,
        markdown: `body-${i}`,
        retention: bounds,
      });
    }
    expect(listVisits({}).rows.map((r) => r.title)).toEqual(['P5', 'P4', 'P3']);
    // Deleting visit rows must still run the orphan sweep for their distinct bodies.
    expect(bodyCount()).toBe(3);
  });

  it('evicts visits past the age bound', () => {
    // The age bound is relative to now, so the old row is dated by clock arithmetic, not by a
    // literal that would age into or out of the window as the calendar moves.
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
    // Seeded under a bound that keeps it, so what the next write proves is that the age bound
    // binds on a row ALREADY stored — not merely that an expired row is refused on arrival.
    visit({ url: 'https://example.com/old', ts: old, title: 'OLD', retention: { ...TINY, maxAgeDays: 365 } });
    expect(visitCount()).toBe(1);
    visit({ url: 'https://example.com/new', title: 'NEW', retention: { ...TINY, maxAgeDays: 30 } });
    expect(listVisits({}).rows.map((r) => r.title)).toEqual(['NEW']);
  });

  it('enforces the byte bound even while the store remains below the row bound', async () => {
    const bounds = { ...TINY, maxVisits: 100, maxBytes: 1500 };
    for (let i = 1; i <= 2; i += 1) {
      visit({
        url: `https://example.com/p${i}`,
        ts: `2026-09-0${i} 10:00:00`,
        title: `P${i}`,
        markdown: `body${i} ` + 'x'.repeat(1000),
        retention: bounds,
      });
    }
    const bytes = (
      getDatabase().prepare('SELECT COALESCE(SUM(byte_len), 0) AS total FROM studio_visit_pages').get() as {
        total: number;
      }
    ).total;
    // Neither the age nor row delete changes anything, so this fails if the unconditional SUM
    // is incorrectly gated on their `.changes` counts.
    expect(bytes).toBeLessThanOrEqual(bounds.maxBytes);
    expect(bodyCount()).toBe(1);
    // The history itself survives the loss of its bodies.
    expect(listVisits({}).rows.map((r) => r.title)).toEqual(['P2', 'P1']);
    expect((await searchVisits({ query: 'body1' })).results).toEqual([]);
    expect((await searchVisits({ query: 'body2' })).results).toHaveLength(1);
  });

  it('does not prepare a body delete while age, row and byte bounds are all idle', () => {
    const db = getDatabase();
    db.prepare(
      `INSERT INTO studio_visit_pages (content_hash, markdown, byte_len, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run('orphan', 'small orphan', 12, new Date().toISOString());

    const prepare = vi.spyOn(db, 'prepare');
    const out = visit({
      ts: new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, ''),
      markdown: null,
      retention: TINY,
    });

    expect(out.stored).toBe(true);
    const sql = prepare.mock.calls.map(([statement]) => String(statement));
    expect(sql.filter((statement) => /^\s*DELETE FROM studio_visit_pages\b/i.test(statement))).toEqual([]);
    expect(bodyCount()).toBe(1);

    const rowCapDelete = sql.find(
      (statement) => /^\s*DELETE FROM studio_visits\b/i.test(statement) && /ORDER BY ts DESC/i.test(statement),
    );
    expect(rowCapDelete).toBeDefined();
    expect(rowCapDelete).not.toMatch(/\bNOT IN\b/i);
    expect(rowCapDelete).toMatch(/\bLIMIT -1 OFFSET \?/i);
  });

  it('stops recording when a bound is disabled, and purges nothing already stored', () => {
    visit({ title: 'KEPT' });
    for (const disabled of [
      { ...TINY, maxVisits: 0 },
      { ...TINY, maxBytes: 0 },
      { ...TINY, maxAgeDays: 0 },
    ]) {
      const out = visit({ url: 'https://example.com/next', title: 'NEW', retention: disabled });
      expect(out.stored).toBe(false);
      expect(out.reason).toBe('retention_disabled');
    }
    // "Stop recording" is not "destroy my history" — the two are different consents.
    expect(listVisits({}).rows.map((r) => r.title)).toEqual(['KEPT']);
  });
});
