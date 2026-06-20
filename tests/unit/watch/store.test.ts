import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDatabase, closeDatabase } from '../../../src/cache/db.js';
import {
  createJob,
  listJobs,
  getJob,
  deleteJob,
  setJobStatus,
  recordCheck,
  getOverdueJobs,
  fingerprintInput,
} from '../../../src/watch/store.js';

/**
 * WHY this matters:
 *   - The `watch` MCP tool persists state across MCP-server restarts. If
 *     create/delete/list aren't durable, users lose their jobs on every
 *     restart and the tool becomes useless.
 *   - Idempotent `create` is the spec's correctness contract: re-running a
 *     watch declaration must NOT duplicate a row. A daemon-less, lazy-run
 *     tool that double-creates pours load onto target sites on every
 *     restart of the calling agent.
 *   - `getOverdueJobs` is the lazy-execution hook the rest of the system
 *     reads. If it returns a paused job, the scheduler will fire it and
 *     break user intent.
 *   - `staleness_seconds` is the user-facing visibility into how overdue a
 *     check is. The numeric semantics (negative = future-due, positive =
 *     overdue) are documented in spec §5 B3.
 */
describe('watch store', () => {
  beforeEach(() => {
    initDatabase(':memory:');
  });

  afterEach(() => {
    closeDatabase();
  });

  describe('createJob', () => {
    it('persists a job with the documented columns', () => {
      const job = createJob({
        url: 'https://example.com/page',
        intervalSeconds: 60,
        notification: 'inline',
      });
      expect(job.id).toBeTruthy();
      expect(job.url).toBe('https://example.com/page');
      expect(job.interval_seconds).toBe(60);
      expect(job.status).toBe('active');
      expect(job.notification).toBe('inline');
      expect(job.created_at).toBeGreaterThan(0);
      expect(job.last_check_at).toBeUndefined();
      expect(job.last_content_hash).toBeUndefined();
    });

    it('is idempotent on identical url + interval + selector — returns existing id', () => {
      const a = createJob({
        url: 'https://example.com/p',
        intervalSeconds: 60,
        selector: '.main',
        notification: 'inline',
      });
      const b = createJob({
        url: 'https://example.com/p',
        intervalSeconds: 60,
        selector: '.main',
        notification: 'inline',
      });
      expect(b.id).toBe(a.id);
      expect(listJobs()).toHaveLength(1);
    });

    it('treats a different interval as a different job', () => {
      createJob({ url: 'https://example.com/q', intervalSeconds: 60, notification: 'inline' });
      createJob({ url: 'https://example.com/q', intervalSeconds: 120, notification: 'inline' });
      expect(listJobs()).toHaveLength(2);
    });

    it('treats a different selector as a different job', () => {
      createJob({ url: 'https://example.com/r', intervalSeconds: 60, selector: '.a', notification: 'inline' });
      createJob({ url: 'https://example.com/r', intervalSeconds: 60, selector: '.b', notification: 'inline' });
      expect(listJobs()).toHaveLength(2);
    });
  });

  describe('listJobs / getJob / deleteJob', () => {
    it('lists jobs in creation order', () => {
      const j1 = createJob({ url: 'https://a.example/', intervalSeconds: 60, notification: 'inline' });
      const j2 = createJob({ url: 'https://b.example/', intervalSeconds: 60, notification: 'inline' });
      const jobs = listJobs();
      expect(jobs[0].id).toBe(j1.id);
      expect(jobs[1].id).toBe(j2.id);
    });

    it('getJob returns null for unknown id', () => {
      expect(getJob('does-not-exist')).toBeNull();
    });

    it('deleteJob removes the row and reports true; subsequent delete reports false', () => {
      const j = createJob({ url: 'https://example.com/x', intervalSeconds: 60, notification: 'inline' });
      expect(deleteJob(j.id)).toBe(true);
      expect(listJobs()).toHaveLength(0);
      expect(deleteJob(j.id)).toBe(false);
    });
  });

  describe('pause / resume', () => {
    it('setJobStatus transitions active -> paused -> active', () => {
      const j = createJob({ url: 'https://example.com/y', intervalSeconds: 60, notification: 'inline' });
      const paused = setJobStatus(j.id, 'paused');
      expect(paused?.status).toBe('paused');
      const resumed = setJobStatus(j.id, 'active');
      expect(resumed?.status).toBe('active');
    });

    it('setJobStatus on unknown id returns null without throwing', () => {
      expect(setJobStatus('nope', 'paused')).toBeNull();
    });
  });

  describe('recordCheck', () => {
    it('updates last_check_at and last_content_hash on the row', () => {
      const j = createJob({ url: 'https://example.com/z', intervalSeconds: 60, notification: 'inline' });
      const at = Date.now();
      const updated = recordCheck(j.id, at, 'hash-1');
      expect(updated?.last_check_at).toBe(at);
      expect(updated?.last_content_hash).toBe('hash-1');
    });
  });

  describe('staleness_seconds', () => {
    it('is approximately -interval just after create (next check still in the future)', () => {
      const j = createJob({ url: 'https://example.com/s', intervalSeconds: 300, notification: 'inline' });
      // Just-created job: dueAt = created_at + 300s, now ~= created_at, so
      // staleness should be close to -300.
      expect(j.staleness_seconds).toBeLessThanOrEqual(-299);
      expect(j.staleness_seconds).toBeGreaterThan(-302);
    });

    it('is positive once the interval has elapsed past last_check_at', () => {
      const j = createJob({ url: 'https://example.com/o', intervalSeconds: 60, notification: 'inline' });
      // Simulate a check 5 minutes ago.
      recordCheck(j.id, Date.now() - 300 * 1000, 'h');
      const refreshed = getJob(j.id);
      expect(refreshed?.staleness_seconds).toBeGreaterThanOrEqual(239);
    });
  });

  describe('getOverdueJobs', () => {
    it('returns active jobs whose next check is due', () => {
      const j = createJob({ url: 'https://example.com/due', intervalSeconds: 60, notification: 'inline' });
      // Force last_check_at into the past.
      recordCheck(j.id, Date.now() - 120 * 1000, 'h');
      const overdue = getOverdueJobs();
      expect(overdue.map((o) => o.id)).toContain(j.id);
    });

    it('excludes paused jobs even when overdue', () => {
      const j = createJob({ url: 'https://example.com/paused', intervalSeconds: 60, notification: 'inline' });
      recordCheck(j.id, Date.now() - 120 * 1000, 'h');
      setJobStatus(j.id, 'paused');
      const overdue = getOverdueJobs();
      expect(overdue.map((o) => o.id)).not.toContain(j.id);
    });

    it('excludes brand-new jobs whose interval has not yet elapsed', () => {
      const j = createJob({ url: 'https://example.com/new', intervalSeconds: 3600, notification: 'inline' });
      const overdue = getOverdueJobs();
      expect(overdue.map((o) => o.id)).not.toContain(j.id);
    });
  });
});

describe('fingerprintInput — separators are NUL escapes, not raw bytes', () => {
  // WHY: the watch job id is sha256(url <sep> interval <sep> selector), and the
  // id is the idempotency key — re-creating the same triple must return the
  // same job, distinct triples must not collide. Each separator MUST be U+0000
  // — a byte that cannot occur in any field — so no two distinct triples can
  // alias by straddling a boundary. Written as the NUL escape, never a raw NUL
  // byte, so the source stays grep-visible (see scripts/check-no-nul.mjs). This
  // pin REDs if either separator degrades to a space (char 32) or vanishes;
  // both occurrences on the join are pinned (charCodeAt, not toContain).
  it('places U+0000 at both field boundaries', () => {
    const url = 'https://x.test/p';
    const interval = 60;
    const s = fingerprintInput(url, interval, 'sel');
    expect(s.charCodeAt(url.length)).toBe(0); // url | interval
    expect(s.charCodeAt(url.length + 1 + String(interval).length)).toBe(0); // interval | selector
  });
});
