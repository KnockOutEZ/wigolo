import type {
  ChangeReport,
  StageResult,
  WatchJobInput,
  WatchJobOutput,
} from '../types.js';
import type { SmartRouter } from '../fetch/router.js';
import {
  createJob,
  deleteJob,
  getJob,
  listJobs,
  setJobStatus,
} from '../watch/store.js';
import { runCheck } from '../watch/scheduler.js';
import { guardUrl } from '../watch/ssrf.js';
import { createLogger } from '../logger.js';

const log = createLogger('cache');

const MIN_INTERVAL_SECONDS = 60;

/**
 * Batch-create cap. The urls[] path runs guardUrl + a SQLite INSERT per
 * entry; without an upper bound a single call can amplify into 100k+
 * inserts and exhaust resources. PR #89 sec reviewer (LOW) — fail-closed
 * here matches the existing badInput envelope for bad URLs.
 */
const MAX_WATCH_BATCH_SIZE = 1000;

function badInput(reason: string, hint?: string): StageResult<WatchJobOutput> {
  return {
    ok: false,
    error: 'invalid_input',
    error_reason: reason,
    stage: 'watch',
    ...(hint ? { hint } : {}),
  };
}

function missing(field: string, action: string): StageResult<WatchJobOutput> {
  return badInput(`watch action=${action} requires "${field}"`, `Set "${field}" on the input.`);
}

/**
 * Lazy-execution model: there is no background daemon. A job's check fires
 * only when:
 *   1. `watch({ action: 'check', job_id })` is called explicitly, OR
 *   2. Any other tool runs and the job is overdue — the server dispatch
 *      chain calls `scheduleOverdueCheck(router)` after handling the
 *      caller's primary request.
 *
 * SSRF guards are applied at registration time so a bad URL can never
 * land in persistent state. The webhook URL receives the same guard.
 */
export async function handleWatch(
  input: WatchJobInput,
  router: SmartRouter,
): Promise<StageResult<WatchJobOutput>> {
  const action = input?.action;
  if (!action) {
    return badInput('watch input requires "action"', 'Set "action" to create | list | check | pause | resume | delete.');
  }

  if (action === 'list') {
    return { ok: true, data: { jobs: listJobs() } };
  }

  if (action === 'create') {
    // Accept `url` (single) OR `urls` (batch). Mutually
    // exclusive — passing both is ambiguous about intent. Single-URL path
    // returns `{ job }` (singular) so callers reading one-shot creates
    // don't have to index into a length-1 array. Batch returns `{ jobs }`.
    const hasUrl = typeof input.url === 'string' && input.url.length > 0;
    const hasUrls = Array.isArray(input.urls) && input.urls.length > 0;
    if (hasUrl && hasUrls) {
      return badInput(
        'watch create accepts either "url" (single) or "urls" (batch), not both',
        'Drop one of the fields — single URL → use "url" and read `{ job }` from the response; multiple → use "urls" and read `{ jobs }`.',
      );
    }
    if (!hasUrl && !hasUrls) return missing('url', 'create');
    if (typeof input.interval_seconds !== 'number' || !Number.isFinite(input.interval_seconds)) {
      return missing('interval_seconds', 'create');
    }
    if (input.interval_seconds < MIN_INTERVAL_SECONDS) {
      return badInput(
        `interval_seconds must be >= ${MIN_INTERVAL_SECONDS}`,
        'Raise interval_seconds to at least 60 to respect target-site rate limits.',
      );
    }

    const notification = input.notification ?? 'inline';
    if (notification !== 'inline') {
      const webhookCheck = guardUrl(notification, 'notification');
      if (!webhookCheck.ok) {
        return badInput(webhookCheck.reason, webhookCheck.hint);
      }
    }

    if (hasUrl) {
      const urlCheck = guardUrl(input.url!, 'url');
      if (!urlCheck.ok) {
        return badInput(urlCheck.reason, urlCheck.hint);
      }
      const job = createJob({
        url: urlCheck.url.toString(),
        intervalSeconds: input.interval_seconds,
        selector: input.selector,
        notification,
      });
      // Single-URL: emit both `job` (new singular surface) and `jobs[]`
      // (legacy back-compat — existing callers index into jobs[0]).
      return { ok: true, data: { job, jobs: [job] } };
    }

    // Batch path: guard every URL up front so a single bad entry doesn't
    // leave half the batch persisted. Fail closed.
    const urls = input.urls!;
    if (urls.length > MAX_WATCH_BATCH_SIZE) {
      return badInput(
        `watch create batch exceeds limit (${urls.length} > ${MAX_WATCH_BATCH_SIZE})`,
        `Split the batch into chunks of at most ${MAX_WATCH_BATCH_SIZE} URLs.`,
      );
    }
    const guarded: ReturnType<typeof guardUrl>[] = [];
    for (const u of urls) {
      const g = guardUrl(u, 'url');
      if (!g.ok) {
        return badInput(g.reason, g.hint);
      }
      guarded.push(g);
    }
    const created = guarded.map((g) => {
      if (!g.ok) throw new Error('unreachable — pre-validated above');
      return createJob({
        url: g.url.toString(),
        intervalSeconds: input.interval_seconds!,
        selector: input.selector,
        notification,
      });
    });
    return { ok: true, data: { jobs: created } };
  }

  if (action === 'check') {
    if (!input.job_id) return missing('job_id', 'check');
    const job = getJob(input.job_id);
    if (!job) {
      return badInput(`watch job not found: ${input.job_id}`, 'Run action=list to enumerate known job_ids.');
    }
    const report = await runCheck(job, router);
    const after = getJob(job.id) ?? job;
    const data: WatchJobOutput = { jobs: [after], changes_since_last: [report] };
    return { ok: true, data };
  }

  if (action === 'pause' || action === 'resume') {
    if (!input.job_id) return missing('job_id', action);
    const next = setJobStatus(input.job_id, action === 'pause' ? 'paused' : 'active');
    if (!next) {
      return badInput(`watch job not found: ${input.job_id}`, 'Run action=list to enumerate known job_ids.');
    }
    return { ok: true, data: { jobs: [next] } };
  }

  if (action === 'delete') {
    if (!input.job_id) return missing('job_id', 'delete');
    const before = getJob(input.job_id);
    if (!before) {
      return badInput(`watch job not found: ${input.job_id}`, 'Run action=list to enumerate known job_ids.');
    }
    deleteJob(input.job_id);
    log.debug('watch job removed', { id: input.job_id });
    return { ok: true, data: { jobs: [before] } };
  }

  return badInput(`unknown watch action: ${String(action)}`, 'Use one of: create | list | check | pause | resume | delete.');
}

/**
 * Surrogate ChangeReport for action paths that need to express "no change
 * yet" without hitting the network — kept as a helper for tests + future
 * docs surfaces.
 */
export function _emptyChangeReport(url: string): ChangeReport {
  return { url, changed: false };
}
