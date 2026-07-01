import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initDatabase, closeDatabase } from '../../../src/cache/db.js';
import { _resetMigrationGuard } from '../../../src/cache/migrations/runner.js';
import { handleWatch } from '../../../src/tools/watch.js';
import {
  scheduleOverdueCheck,
  runCheck,
  _resetSchedulerGuard,
} from '../../../src/watch/scheduler.js';
import { listJobs, recordCheck } from '../../../src/watch/store.js';
import type { SmartRouter } from '../../../src/fetch/router.js';
import type { WatchJobOutput, StageResult } from '../../../src/types.js';

/**
 * WHY this matters:
 *   - The watch handler is the contract the LLM sees. Each action
 *     (create / list / check / pause / resume / delete) is exercised here
 *     against the real DB so a regression in any branch is caught.
 *   - The lazy-fire hook is the only way overdue jobs ever execute in
 *     wigolo. If the dispatch wiring breaks, watch silently stops working
 *     even if every other test still passes. The "lazy hook triggers
 *     overdue job" test pins that integration point.
 *   - SSRF guards must apply to BOTH `url` and `notification`. Two
 *     dedicated assertions here so a regression that drops the webhook
 *     guard doesn't slip through.
 */

function mustOk<T>(r: StageResult<T>): T {
  if (!r.ok) {
    throw new Error(`expected ok, got error: ${r.error_reason}`);
  }
  return r.data;
}

function mockRouter(markdown: string): SmartRouter {
  // Minimal router — handleFetch calls into the cache layer first, so we
  // mock the underlying SmartRouter.fetch() to a deterministic markdown
  // payload. The handler doesn't otherwise touch the network.
  return {
    fetch: vi.fn(async (url: string) => ({
      url,
      finalUrl: url,
      html: `<html><body><p>${markdown}</p></body></html>`,
      contentType: 'text/html',
      statusCode: 200,
      headers: {},
      method: 'http' as const,
    })),
    getDomainStats: vi.fn(),
  } as unknown as SmartRouter;
}

describe('watch handler', () => {
  beforeEach(() => {
    _resetMigrationGuard();
    _resetSchedulerGuard();
    initDatabase(':memory:');
  });

  afterEach(() => {
    closeDatabase();
  });

  describe('create', () => {
    it('persists a new job and returns its id', async () => {
      const router = mockRouter('hello');
      const r = mustOk(await handleWatch(
        { action: 'create', url: 'https://example.com/p', interval_seconds: 60 },
        router,
      ));
      expect(r.jobs).toHaveLength(1);
      expect(r.jobs[0].url).toBe('https://example.com/p');
      expect(r.jobs[0].status).toBe('active');
    });

    // Single-URL create returns `{ job }` (singular) alongside
    // the legacy `{ jobs[0] }` shape. Batch (urls[]) returns `{ jobs }`
    // without a `job` field. The singular path used to always emit `jobs[]`,
    // which read as "this MAY be plural" to callers.
    it('returns a singular `job` field when one URL is passed', async () => {
      const router = mockRouter('hello');
      const r = mustOk(await handleWatch(
        { action: 'create', url: 'https://example.com/m17-single', interval_seconds: 60 },
        router,
      ));
      expect(r.job).toBeDefined();
      expect(r.job!.url).toBe('https://example.com/m17-single');
      // Legacy `jobs[]` is still emitted for back-compat.
      expect(r.jobs).toHaveLength(1);
      expect(r.jobs[0].id).toBe(r.job!.id);
    });

    it('returns `jobs[]` without a `job` field when batch urls[] are passed', async () => {
      const router = mockRouter('hello');
      const r = mustOk(await handleWatch(
        {
          action: 'create',
          urls: ['https://example.com/m17-batch-a', 'https://example.com/m17-batch-b'],
          interval_seconds: 60,
        },
        router,
      ));
      expect(r.jobs).toHaveLength(2);
      expect(r.job).toBeUndefined();
      const urls = r.jobs.map((j) => j.url).sort();
      expect(urls).toEqual([
        'https://example.com/m17-batch-a',
        'https://example.com/m17-batch-b',
      ]);
    });

    // PR #89 sec reviewer (LOW): the batch urls[] path runs guardUrl +
    // createJob (which is a SQLite INSERT) per URL. With no upper bound,
    // a caller passing 100k URLs eats 100k inserts. Fail-closed here is
    // cheap and matches the existing badInput envelope for bad URLs.
    it('rejects an oversized batch (urls.length > MAX_WATCH_BATCH_SIZE)', async () => {
      const router = mockRouter('');
      const tooMany = Array.from({ length: 1001 }, (_, i) => `https://example.com/m17-cap-${i}`);
      const r = await handleWatch(
        { action: 'create', urls: tooMany, interval_seconds: 60 },
        router,
      );
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toBe('invalid_input');
        expect(r.error_reason).toMatch(/batch|limit|too many|1000/i);
      }
      // Defence in depth: no jobs should have been persisted.
      const after = mustOk(await handleWatch({ action: 'list' }, router));
      expect(after.jobs).toHaveLength(0);
    });

    it('accepts a batch at exactly MAX_WATCH_BATCH_SIZE (cap is inclusive)', async () => {
      const router = mockRouter('');
      const atLimit = Array.from({ length: 1000 }, (_, i) => `https://example.com/m17-atcap-${i}`);
      const r = await handleWatch(
        { action: 'create', urls: atLimit, interval_seconds: 60 },
        router,
      );
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.data.jobs).toHaveLength(1000);
      }
    });

    it('rejects passing both url and urls (ambiguous intent)', async () => {
      const router = mockRouter('hello');
      const r = await handleWatch(
        {
          action: 'create',
          url: 'https://example.com/x',
          urls: ['https://example.com/y'],
          interval_seconds: 60,
        },
        router,
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error_reason).toMatch(/url.*urls|urls.*url/i);
    });

    it('rejects interval_seconds below 60', async () => {
      const router = mockRouter('');
      const r = await handleWatch(
        { action: 'create', url: 'https://example.com/p', interval_seconds: 30 },
        router,
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error_reason).toMatch(/60/);
    });

    it('rejects when url is missing', async () => {
      const router = mockRouter('');
      const r = await handleWatch(
        { action: 'create', interval_seconds: 60 },
        router,
      );
      expect(r.ok).toBe(false);
    });

    it('is idempotent — repeated create returns the same job_id', async () => {
      const router = mockRouter('');
      const a = mustOk(await handleWatch(
        { action: 'create', url: 'https://example.com/x', interval_seconds: 60 },
        router,
      ));
      const b = mustOk(await handleWatch(
        { action: 'create', url: 'https://example.com/x', interval_seconds: 60 },
        router,
      ));
      expect(b.jobs[0].id).toBe(a.jobs[0].id);
      const all = mustOk(await handleWatch({ action: 'list' }, router));
      expect(all.jobs).toHaveLength(1);
    });

    it('SSRF: rejects http://localhost as the watched url', async () => {
      const router = mockRouter('');
      const r = await handleWatch(
        { action: 'create', url: 'http://localhost:3000/x', interval_seconds: 60 },
        router,
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error_reason).toMatch(/loopback|private/i);
    });

    it('SSRF: rejects RFC 1918 ranges as the watched url', async () => {
      const router = mockRouter('');
      const r = await handleWatch(
        { action: 'create', url: 'http://192.168.1.1/admin', interval_seconds: 60 },
        router,
      );
      expect(r.ok).toBe(false);
    });

    it('SSRF: rejects file:// as the watched url', async () => {
      const router = mockRouter('');
      const r = await handleWatch(
        { action: 'create', url: 'file:///etc/passwd', interval_seconds: 60 },
        router,
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error_reason).toMatch(/protocol/i);
    });

    it('SSRF: rejects a webhook notification pointed at metadata service', async () => {
      // Even if the watched url is fine, the webhook target gets the same
      // guard so a malicious job cannot POST a diff back to a private host.
      const router = mockRouter('');
      const r = await handleWatch(
        {
          action: 'create',
          url: 'https://example.com/p',
          interval_seconds: 60,
          notification: 'http://169.254.169.254/exfil',
        },
        router,
      );
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error_reason).toContain('notification');
        expect(r.error_reason).toMatch(/private|link/i);
      }
    });

    it('SSRF: accepts a public https webhook target', async () => {
      const router = mockRouter('');
      const r = await handleWatch(
        {
          action: 'create',
          url: 'https://example.com/p',
          interval_seconds: 60,
          notification: 'https://hooks.example.com/incoming',
        },
        router,
      );
      expect(r.ok).toBe(true);
    });
  });

  describe('list', () => {
    it('returns staleness_seconds for each job', async () => {
      const router = mockRouter('');
      await handleWatch(
        { action: 'create', url: 'https://example.com/p', interval_seconds: 60 },
        router,
      );
      const r = mustOk(await handleWatch({ action: 'list' }, router));
      expect(r.jobs).toHaveLength(1);
      expect(typeof r.jobs[0].staleness_seconds).toBe('number');
      // Just-created job, interval 60: dueAt ~ created_at + 60s, now ~= created_at,
      // so staleness should be approximately -60.
      expect(r.jobs[0].staleness_seconds).toBeLessThanOrEqual(-59);
    });
  });

  describe('check', () => {
    it('fetches the URL and records a baseline on first check', async () => {
      const router = mockRouter('initial body');
      const created = mustOk(await handleWatch(
        { action: 'create', url: 'https://example.com/page', interval_seconds: 60 },
        router,
      ));
      const r = mustOk(await handleWatch(
        { action: 'check', job_id: created.jobs[0].id },
        router,
      ));
      expect(r.changes_since_last).toHaveLength(1);
      // First check: no previous hash, so we record the baseline and
      // report changed=false. This is the documented behaviour.
      expect(r.changes_since_last?.[0].changed).toBe(false);
      expect(r.jobs[0].last_content_hash).toBeTruthy();
      expect(r.jobs[0].last_check_at).toBeGreaterThan(0);
    });

    it('reports changed=true on the second check when body differs', async () => {
      const router1 = mockRouter('v1 body');
      const created = mustOk(await handleWatch(
        { action: 'create', url: 'https://example.com/diff', interval_seconds: 60 },
        router1,
      ));
      // Baseline first.
      mustOk(await handleWatch(
        { action: 'check', job_id: created.jobs[0].id },
        router1,
      ));
      // Second router yields a different body — the hash must differ.
      const router2 = mockRouter('v2 body completely different');
      const r = mustOk(await handleWatch(
        { action: 'check', job_id: created.jobs[0].id },
        router2,
      ));
      expect(r.changes_since_last?.[0].changed).toBe(true);
      expect(r.changes_since_last?.[0].previous_hash).toBeTruthy();
      expect(r.changes_since_last?.[0].current_hash).toBeTruthy();
      expect(r.changes_since_last?.[0].previous_hash).not.toBe(r.changes_since_last?.[0].current_hash);
    });

    it('rejects when job_id is missing', async () => {
      const router = mockRouter('');
      const r = await handleWatch({ action: 'check' }, router);
      expect(r.ok).toBe(false);
    });

    it('rejects when job_id is unknown', async () => {
      const router = mockRouter('');
      const r = await handleWatch(
        { action: 'check', job_id: 'does-not-exist' },
        router,
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error_reason).toMatch(/not found/);
    });
  });

  describe('pause / resume', () => {
    it('flips status correctly', async () => {
      const router = mockRouter('');
      const created = mustOk(await handleWatch(
        { action: 'create', url: 'https://example.com/pause', interval_seconds: 60 },
        router,
      ));
      const paused = mustOk(await handleWatch(
        { action: 'pause', job_id: created.jobs[0].id },
        router,
      ));
      expect(paused.jobs[0].status).toBe('paused');
      const resumed = mustOk(await handleWatch(
        { action: 'resume', job_id: created.jobs[0].id },
        router,
      ));
      expect(resumed.jobs[0].status).toBe('active');
    });
  });

  describe('delete', () => {
    it('removes the job and returns the deleted record', async () => {
      const router = mockRouter('');
      const created = mustOk(await handleWatch(
        { action: 'create', url: 'https://example.com/del', interval_seconds: 60 },
        router,
      ));
      const r = mustOk(await handleWatch(
        { action: 'delete', job_id: created.jobs[0].id },
        router,
      ));
      expect(r.jobs[0].id).toBe(created.jobs[0].id);
      const remaining = mustOk(await handleWatch({ action: 'list' }, router));
      expect(remaining.jobs).toHaveLength(0);
    });
  });

  describe('lazy fire integration', () => {
    it('scheduleOverdueCheck runs overdue jobs without blocking the caller', async () => {
      const router = mockRouter('lazy body');
      const created = mustOk(await handleWatch(
        { action: 'create', url: 'https://example.com/lazy', interval_seconds: 60 },
        router,
      ));
      // Force the job into the overdue window.
      recordCheck(created.jobs[0].id, Date.now() - 120 * 1000, 'old-hash');

      // Fire the lazy hook (this is what the server dispatch chain calls
      // on every non-watch tool). It uses setImmediate, so we wait a tick.
      scheduleOverdueCheck(router);
      await new Promise((r) => setTimeout(r, 50));

      const after = listJobs();
      expect(after).toHaveLength(1);
      // last_content_hash should now be the new body's hash (different
      // from the synthetic 'old-hash' we seeded above).
      expect(after[0].last_content_hash).not.toBe('old-hash');
      expect(after[0].last_check_at).toBeGreaterThan(Date.now() - 5000);
    });

    it('does not fire paused jobs even when overdue', async () => {
      const router = mockRouter('paused body');
      const created = mustOk(await handleWatch(
        { action: 'create', url: 'https://example.com/p2', interval_seconds: 60 },
        router,
      ));
      recordCheck(created.jobs[0].id, Date.now() - 120 * 1000, 'baseline-hash');
      await handleWatch(
        { action: 'pause', job_id: created.jobs[0].id },
        router,
      );

      scheduleOverdueCheck(router);
      await new Promise((r) => setTimeout(r, 50));

      const after = listJobs();
      // Paused job's hash should be unchanged because the scheduler skipped it.
      expect(after[0].last_content_hash).toBe('baseline-hash');
    });

    it('webhook delivery does NOT follow 3xx redirects (SSRF: redirect to 127.0.0.1)', async () => {
      // A public webhook URL passes the guard at registration time, but the
      // target server can return 307/308 redirecting to http://127.0.0.1/.
      // Node's default fetch follows redirects transparently, which would
      // bypass the SSRF guard at delivery time. We assert that the webhook
      // fetch is invoked with `redirect: 'manual'` AND that no follow-up
      // request to the loopback Location target ever happens.
      const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => {
        // Return a 308 with a loopback Location header. With
        // redirect:'manual' the runtime returns this response to the caller
        // and never re-fetches; with redirect:'follow' (the default), the
        // runtime would transparently re-fetch http://127.0.0.1/admin.
        return new Response('', {
          status: 308,
          headers: { location: 'http://127.0.0.1/admin' },
        });
      });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = fetchMock as typeof globalThis.fetch;
      try {
        const router = mockRouter('changed body');
        // Create with a public webhook target so the guard passes.
        const created = mustOk(await handleWatch(
          {
            action: 'create',
            url: 'https://example.com/page',
            interval_seconds: 60,
            notification: 'https://hooks.example.com/incoming',
          },
          router,
        ));
        // Establish a baseline so the next check reports `changed=true` and
        // triggers the webhook.
        mustOk(await handleWatch(
          { action: 'check', job_id: created.jobs[0].id },
          router,
        ));
        // Swap router payload so the second check sees a different body.
        const router2 = mockRouter('totally different body');
        mustOk(await handleWatch(
          { action: 'check', job_id: created.jobs[0].id },
          router2,
        ));
        // The webhook is delivered via setImmediate / void; flush.
        await new Promise((r) => setTimeout(r, 100));

        // 1) The webhook fetch must have been invoked with redirect:'manual'.
        //    This is the load-bearing assertion — without it, a regression
        //    to redirect:'follow' (the fetch default) silently bypasses the
        //    guard at delivery time.
        const calls = fetchMock.mock.calls;
        expect(calls.length).toBeGreaterThan(0);
        const webhookCall = calls.find(
          (c) => String(c[0]) === 'https://hooks.example.com/incoming',
        );
        expect(webhookCall).toBeDefined();
        const init = webhookCall![1] as RequestInit | undefined;
        expect(init?.redirect).toBe('manual');
        // 2) Defence in depth — the implementation must never re-fetch the
        //    Location header itself.
        const urls = calls.map((c) => String(c[0]));
        expect(urls.some((u) => u.includes('127.0.0.1'))).toBe(false);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('runCheck records last_check_at even on fetch failure (avoids hot-looping a dead URL)', async () => {
      const failingRouter = {
        fetch: vi.fn(async () => {
          throw new Error('network down');
        }),
        getDomainStats: vi.fn(),
      } as unknown as SmartRouter;

      const created = mustOk(await handleWatch(
        { action: 'create', url: 'https://example.com/down', interval_seconds: 60 },
        failingRouter,
      ));
      const before = Date.now();
      await runCheck(created.jobs[0], failingRouter);
      const after = listJobs();
      expect(after[0].last_check_at).toBeGreaterThanOrEqual(before);
    });
  });
});
