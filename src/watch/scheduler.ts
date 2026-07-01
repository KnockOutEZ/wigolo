import { createHash } from 'node:crypto';
import { createLogger } from '../logger.js';
import type { SmartRouter } from '../fetch/router.js';
import type { ChangeReport, WatchJob } from '../types.js';
import { computeDiffSummary } from '../cache/diff-summary.js';
import { handleFetch } from '../tools/fetch.js';
import { getOverdueJobs, recordCheck, getJob } from './store.js';
import { guardUrl } from './ssrf.js';

const log = createLogger('cache');

/**
 * Run a single watch job. Fetches the URL (re-using the existing fetch
 * tier — http, smart-router escalation to Playwright when the page
 * requires JS, the local cache when fresh enough), hashes the body, and
 * compares against the previous content hash stored on the job.
 *
 * NOTE: the spec called for an optional CSS selector to scope the diff.
 * The current fetch path returns full-page markdown; scoping by selector
 * is a feature follow-up — the column is persisted now so the watch tool
 * surface is forward-compatible, but the selector is not yet honoured by
 * the diff and we surface that limitation in the scheduler's log line.
 */
export async function runCheck(
  job: WatchJob,
  router: SmartRouter,
): Promise<ChangeReport> {
  const report: ChangeReport = { url: job.url, changed: false };
  // Re-run the SSRF guard at check time. The guard is also enforced at
  // registration, but re-checking here makes the guards composable: if the
  // policy ever tightens, previously-persisted jobs don't get grandfathered
  // into a now-forbidden URL space.
  const urlGuard = guardUrl(job.url, 'url');
  if (!urlGuard.ok) {
    report.error = urlGuard.reason;
    log.warn('watch check rejected by ssrf guard', {
      id: job.id,
      url: job.url,
      reason: urlGuard.reason,
    });
    recordCheck(job.id, Date.now(), job.last_content_hash ?? '');
    return report;
  }
  if (job.notification && job.notification !== 'inline') {
    const notifGuard = guardUrl(job.notification, 'notification');
    if (!notifGuard.ok) {
      report.error = notifGuard.reason;
      log.warn('watch check rejected by ssrf guard', {
        id: job.id,
        notification: job.notification,
        reason: notifGuard.reason,
      });
      recordCheck(job.id, Date.now(), job.last_content_hash ?? '');
      return report;
    }
  }

  try {
    const fetched = await handleFetch(
      { url: job.url, include_full_markdown: true, force_refresh: true },
      router,
    );
    if (!fetched.ok) {
      report.error = fetched.error_reason ?? fetched.error;
      log.warn('watch check fetch failed', { id: job.id, url: job.url, error: report.error });
      // Even on fetch failure we touch last_check_at so the job doesn't
      // hammer a permanently-broken URL every tool call.
      recordCheck(job.id, Date.now(), job.last_content_hash ?? '');
      return report;
    }

    const markdown = fetched.data.markdown ?? '';
    const currentHash = createHash('sha256').update(markdown).digest('hex');
    report.current_hash = currentHash;

    const previousHash = job.last_content_hash;
    if (!previousHash) {
      // First successful check — record the baseline but report no change.
      recordCheck(job.id, Date.now(), currentHash);
      log.info('watch baseline recorded', { id: job.id, url: job.url });
      return report;
    }

    if (previousHash === currentHash) {
      recordCheck(job.id, Date.now(), currentHash);
      return report;
    }

    report.changed = true;
    report.previous_hash = previousHash;
    if (job.selector) {
      // We persist the selector so the surface is forward-compatible but the
      // diff itself is full-page until selector-scoped extraction lands.
      log.debug('watch selector recorded but not yet applied to diff', {
        id: job.id,
        selector: job.selector,
      });
    }
    report.diff_summary = computeDiffSummary('', markdown); // approximate — without prior body
    // If we still hold the prior markdown in the URL cache for this same
    // page (handleFetch with force_refresh:true overwrote it), this summary
    // is just a line-count of the new body. Real prior-body diffing is
    // handled by the `diff` engine; this path surfaces a coarse marker.

    recordCheck(job.id, Date.now(), currentHash);
    log.info('watch change detected', { id: job.id, url: job.url });

    // Webhook delivery. Minimal — POST the change report, fire-and-forget.
    // No retry / backoff / queue — those belong to a follow-up batch.
    if (job.notification && job.notification !== 'inline') {
      void deliverWebhook(job.notification, { job_id: job.id, ...report }).catch((err) => {
        log.warn('watch webhook delivery failed', {
          id: job.id,
          url: job.notification,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
    return report;
  } catch (err) {
    report.error = err instanceof Error ? err.message : String(err);
    log.warn('watch check threw', { id: job.id, error: report.error });
    return report;
  }
}

/**
 * Lazy hook fired by every other tool's dispatch path. Looks at jobs whose
 * interval has elapsed and runs them in the background. Never blocks the
 * calling tool — exceptions are caught and logged.
 *
 * The hook gates itself behind an in-process re-entrancy guard so a tool
 * that triggers `watch`-flavoured fetches doesn't recursively re-enter the
 * scheduler from inside its own check.
 */
let firing = false;

export async function triggerOverdueJobs(router: SmartRouter): Promise<void> {
  if (firing) return;
  firing = true;
  try {
    let overdue: WatchJob[];
    try {
      overdue = getOverdueJobs();
    } catch (err) {
      // The database may not be initialised when the lazy hook runs — e.g.
      // a tool dispatch happens during early server boot or a teardown
      // path. We swallow these silently; the scheduler is best-effort.
      log.debug('watch lazy fire skipped — db not ready', {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (overdue.length === 0) return;
    log.debug('watch lazy fire', { count: overdue.length });
    for (const job of overdue) {
      // Re-read to make sure status didn't flip after getOverdueJobs but
      // before we ran the check (paused while we were enumerating, say).
      const fresh = getJob(job.id);
      if (!fresh || fresh.status !== 'active') continue;
      await runCheck(fresh, router).catch((err) => {
        log.warn('watch lazy check failed', { id: job.id, error: String(err) });
      });
    }
  } finally {
    firing = false;
  }
}

/**
 * Schedule the lazy hook without blocking the caller. The MCP tool
 * dispatch chain calls this; we deliberately swallow the returned promise
 * because tool-level latency must not be inflated by overdue watch jobs.
 */
export function scheduleOverdueCheck(router: SmartRouter): void {
  setImmediate(() => {
    void triggerOverdueJobs(router).catch((err) => {
      // Swallow at debug — the hook is best-effort and must never noise
      // the operator log when the DB has been torn down underneath it.
      log.debug('watch overdue trigger failed', { error: String(err) });
    });
  });
}

async function deliverWebhook(
  webhookUrl: string,
  payload: Record<string, unknown>,
): Promise<void> {
  // Minimal POST. We rely on the runtime's built-in fetch (Node 20+) so
  // there's no extra dependency. Failures are swallowed by the caller's
  // catch — webhooks are best-effort by spec, not a delivery guarantee.
  //
  // `redirect: 'manual'` is load-bearing for the SSRF guard. A public
  // webhook URL passes the guardUrl check at registration time, but the
  // target server can return 307/308 redirecting to e.g.
  // http://127.0.0.1/admin. With the default `redirect: 'follow'`, Node's
  // fetch would silently re-issue the POST against the loopback target,
  // bypassing the SSRF guard at delivery time. We treat any 3xx as a hard
  // delivery error and never chase the Location.
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    redirect: 'manual',
  });
  if (res.status >= 300 && res.status < 400) {
    log.debug('webhook redirect refused', {
      url: webhookUrl,
      status: res.status,
      location: res.headers.get('location') ?? null,
    });
    throw new Error(`webhook returned a redirect (${res.status}); not followed`);
  }
  if (!res.ok) {
    throw new Error(`webhook responded ${res.status}`);
  }
}

/** Test-only — reset the in-process re-entrancy guard between cases. */
export function _resetSchedulerGuard(): void {
  firing = false;
}
