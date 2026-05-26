import type { SearchResultItem } from '../types.js';
import type { SmartRouter } from '../fetch/router.js';
import { getExtractProvider } from '../providers/extract-provider.js';
import { cacheContent } from '../cache/store.js';
import { getEmbeddingService } from '../embedding/embed.js';
import { truncateSmartly } from './truncate.js';
import { createLogger } from '../logger.js';

const log = createLogger('search');

export interface FetchContentContext {
  contentMaxChars: number;
  maxContentChars?: number;
  maxTotalChars: number;
  fetchTimeoutMs: number;
  totalDeadline: number;
  forceRefresh: boolean;
  maxFetches?: number;
}

interface SingleFetch {
  content?: string;
  error?: string;
}

async function fetchOne(
  url: string,
  router: SmartRouter,
  ctx: FetchContentContext,
): Promise<SingleFetch> {
  if (Date.now() >= ctx.totalDeadline) {
    return { error: 'total_timeout' };
  }
  try {
    const raw = await Promise.race([
      router.fetch(url, {
        renderJs: 'auto',
        ...(ctx.forceRefresh && { force_refresh: true }),
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), ctx.fetchTimeoutMs),
      ),
    ]);
    const extractor = await getExtractProvider();
    const extraction = await extractor.extract(raw.html, raw.finalUrl, {
      maxChars: ctx.contentMaxChars,
      contentType: raw.contentType,
    });

    try {
      cacheContent(raw, extraction);
    } catch (err) {
      log.warn('failed to cache search result', { url, error: String(err) });
    }

    try {
      const embeddingService = getEmbeddingService();
      if (embeddingService.isAvailable()) {
        embeddingService.embedAsync(raw.finalUrl, extraction.markdown);
      }
    } catch (err) {
      log.debug('embedding hook skipped for search result', { error: String(err) });
    }

    const md = ctx.maxContentChars !== undefined
      ? truncateSmartly(extraction.markdown, ctx.maxContentChars)
      : extraction.markdown;
    return { content: md };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.debug('content fetch failed', { url, error: msg });
    return { error: msg };
  }
}

// Parallel fetch all URLs; then apply total-char budget in relevance (input)
// order. Mutates each SearchResultItem in place with markdown_content, or
// fetch_failed/content_truncated metadata when applicable.
//
// Slice S1 (M16): when `max_fetches > 1` and one of the top-N parallel
// fetches fails, attempt fallback fetches from `results[maxFetches..]`
// within the remaining timeout budget. One backup attempt per failed slot
// — keeps the total successful-fetch count from exceeding the cap (so
// `max_fetches: N` still means "at most N pages of content") while
// healing transient timeouts on the top candidate. `max_fetches: 1` is
// deliberately exempt: the user asked for exactly one, no fallback.
export async function fetchContentForResults(
  results: SearchResultItem[],
  router: SmartRouter,
  ctx: FetchContentContext,
): Promise<void> {
  const cap = ctx.maxFetches !== undefined ? ctx.maxFetches : results.length;
  const fetchTargets = results.slice(0, cap);
  const attempted = new Set<string>(fetchTargets.map((r) => r.url));
  const fetched = await Promise.all(
    fetchTargets.map((r) => fetchOne(r.url, router, ctx)),
  );

  // Track which backup URL (if any) filled each failed slot. The backup's
  // content lands in the backup's own SearchResultItem (preserving the
  // failed slot's diagnostic info) — callers can then see both the
  // attempted failure and the substitute success.
  //
  // Wave strategy: count how many top slots still need a backup, then fire
  // that many deeper-candidate fetches IN PARALLEL. If some of those waves
  // also fail, repeat with the next batch. This preserves the
  // "no more than `cap` successful fetches" invariant while keeping wall-
  // clock close to a single fetch duration — slot-by-slot serialization
  // would multiply latency by the number of failed slots.
  if (cap > 1 && results.length > cap) {
    const originalFailedCount = fetched.filter((f) => f.content === undefined).length;
    let backupsAccepted = 0;
    let nextBackupIdx = cap;
    while (
      Date.now() < ctx.totalDeadline &&
      nextBackupIdx < results.length &&
      backupsAccepted < originalFailedCount
    ) {
      const stillNeeded = originalFailedCount - backupsAccepted;

      // Collect the next wave of backup candidates, dedup-protected and
      // bounded by remaining results.length.
      const wave: SearchResultItem[] = [];
      while (wave.length < stillNeeded && nextBackupIdx < results.length) {
        const candidate = results[nextBackupIdx];
        nextBackupIdx++;
        if (attempted.has(candidate.url)) continue;
        attempted.add(candidate.url);
        wave.push(candidate);
      }
      if (wave.length === 0) break;

      const waveResults = await Promise.all(
        wave.map((r) => fetchOne(r.url, router, ctx)),
      );

      // Promote successful backups into fetchTargets / fetched. The order
      // of insertion mirrors the wave order, which keeps the relevance-
      // ordered char-budget loop below deterministic.
      for (let i = 0; i < wave.length; i++) {
        if (waveResults[i].content === undefined) continue;
        if (backupsAccepted >= originalFailedCount) break; // never overshoot cap
        fetchTargets.push(wave[i]);
        fetched.push(waveResults[i]);
        backupsAccepted++;
      }
    }
  }

  let totalCharsUsed = 0;
  for (let i = 0; i < fetchTargets.length; i++) {
    const result = fetchTargets[i];
    const { content, error } = fetched[i];

    if (error) {
      result.fetch_failed = error;
      continue;
    }
    if (content === undefined) continue;

    if (totalCharsUsed >= ctx.maxTotalChars) {
      result.content_truncated = true;
      continue;
    }

    let out = content;
    const remaining = ctx.maxTotalChars - totalCharsUsed;
    if (out.length > remaining) {
      out = out.slice(0, remaining);
      result.content_truncated = true;
    }

    totalCharsUsed += out.length;
    result.markdown_content = out;
  }
}
