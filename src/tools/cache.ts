import {
  searchCacheFiltered,
  countCacheFiltered,
  getCacheStats,
  clearCacheEntries,
} from '../cache/store.js';
import { runFtsCacheSearch, runHybridSearch } from '../cache/hybrid-search.js';
import { detectChange } from '../cache/change-detector.js';
import { isVersionRequest, readVersions } from '../cache/version-read.js';
import { getExtractProvider } from '../providers/extract-provider.js';
import { isStageError, describeStageError } from '../fetch/error-describe.js';
import {
  applyCacheOutputBudget,
  buildChangesTruncation,
  resolveCheckChangesLimit,
} from '../cache/output-budget.js';
import { createLogger } from '../logger.js';
import type { CacheInput, CacheOutput, ChangeReport } from '../types.js';
import type { SmartRouter } from '../fetch/router.js';

const log = createLogger('cache');

// cache.query default limit. The cache table can hold thousands of rows;
// without a tight default the response easily blows token budgets. Callers who
// genuinely need more results still get them by passing `limit` explicitly.
const DEFAULT_CACHE_QUERY_LIMIT = 5;

/**
 * The present-tense mode a time-axis request collides with, or null.
 *
 * Named rather than inlined so the set is enumerated in one place: a fourth
 * present-tense flag added later has exactly one line to miss instead of an
 * `if` chain to be quietly appended after.
 */
function conflictingModeFor(input: CacheInput): string | null {
  if (!isVersionRequest(input)) return null;
  if (input.check_changes) return 'check_changes';
  if (input.stats) return 'stats';
  if (input.clear) return 'clear';
  return null;
}

export async function handleCache(input: CacheInput, router?: SmartRouter): Promise<CacheOutput> {
  try {
    // `at` / `versions` ask about the PAST; check_changes, stats and clear all act
    // on the present, and each of them returns before the time-axis branch below.
    // So the combination cannot be served — and it must not be served PARTIALLY:
    // `cache({url, at, check_changes: true})` would issue live network re-fetches
    // and answer with present-tense change reports while silently dropping `at`,
    // which is a past-time question answered with the present. That is the exact
    // failure this surface exists to refuse, so it is refused explicitly here
    // rather than left to branch order to decide.
    const conflict = conflictingModeFor(input);
    if (conflict) {
      const axis = input.at !== undefined ? 'at' : 'versions';
      return {
        error:
          `${conflict} cannot be combined with ${axis}: ${conflict} acts on the current ` +
          `state of the cache, while ${axis} reads retained history. Run them as separate calls.`,
      };
    }

    if (input.check_changes) {
      log.info('Checking for content changes', {
        query: input.query,
        urlPattern: input.url_pattern,
        since: input.since,
      });

      // Every entry here is re-fetched over the network, so the row cap bounds
      // live requests as much as output. It is passed to the store explicitly:
      // relying on the store's own default silently capped the work at 100 and
      // made an explicit larger `limit` inert, with nothing in the response
      // saying so. The true match count comes from a count query because a
      // LIMITed result length cannot tell "everything" from "the first page".
      const filter = {
        query: input.query,
        urlPattern: input.url_pattern,
        since: input.since,
      };
      const checkLimit = resolveCheckChangesLimit(input.limit);
      const entries = searchCacheFiltered({ ...filter, limit: checkLimit });
      // A short page proves there was nothing more to take. Only a full page is
      // ambiguous between "everything" and "the first page", so only then is the
      // extra count worth a scan.
      const matchedCount =
        entries.length < checkLimit ? entries.length : countCacheFiltered(filter);

      const changes: ChangeReport[] = [];
      for (const entry of entries) {
        try {
          if (!router) {
            changes.push({
              url: entry.url,
              changed: false,
              current_hash: entry.contentHash,
              error: 'no router available for re-fetch',
            });
            continue;
          }
          const raw = await router.fetch(entry.url, { renderJs: 'auto' });
          // A refused re-fetch means we do not KNOW whether the page changed. Reporting
          // `changed: false` on its own would assert the opposite — that we checked and it
          // was identical — so the refusal goes in the report's `error` field, which is
          // exactly the "could not check" channel the no-router branch above already uses.
          if (isStageError(raw)) {
            log.warn('change check refused for URL', {
              url: entry.url,
              error: raw.error,
              reason: raw.error_reason,
            });
            changes.push({
              url: entry.url,
              changed: false,
              current_hash: entry.contentHash,
              error: describeStageError(raw),
            });
            continue;
          }
          const extractor = await getExtractProvider();
          const extraction = await extractor.extract(raw.html, raw.finalUrl, {
            contentType: raw.contentType,
          });
          // Pass the upstream status code so cache check_changes
          // surfaces 200→404 transitions as changes even when the body hash
          // matches — silent equality on missing pages was a
          // "cache treats 404 as identical content" failure mode.
          const changeResult = detectChange(entry.url, extraction.markdown, raw.statusCode);
          changes.push({
            url: entry.url,
            changed: changeResult.changed,
            current_hash: entry.contentHash,
            ...(changeResult.changed ? {
              previous_hash: changeResult.previousHash,
              diff_summary: changeResult.diffSummary,
            } : {}),
          });
        } catch (err) {
          log.warn('change check failed for URL', {
            url: entry.url,
            error: err instanceof Error ? err.message : String(err),
          });
          changes.push({
            url: entry.url,
            changed: false,
            current_hash: entry.contentHash,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (matchedCount > entries.length) {
        return {
          changes,
          changes_truncation: buildChangesTruncation(matchedCount, entries.length, input.limit),
        };
      }
      return { changes };
    }

    if (input.stats) {
      log.debug('Cache stats requested');
      return { stats: getCacheStats() };
    }

    if (input.clear) {
      if (!input.query && !input.url_pattern && !input.since) {
        return { error: 'clear requires at least one filter (query, url_pattern, or since)' };
      }
      log.info('Clearing cache entries', {
        query: input.query,
        urlPattern: input.url_pattern,
        since: input.since,
      });
      const count = clearCacheEntries({
        query: input.query,
        urlPattern: input.url_pattern,
        since: input.since,
      });
      return { cleared: count };
    }

    // The time axis. This sits AFTER the present-tense modes above, which is why
    // the collision is refused at the top of the function rather than described
    // here: a caller who passed `at` or `versions` must never silently receive an
    // ordinary current-page answer, and branch order alone does not deliver that.
    // It DOES precede the search paths, so `query` + `at` reads history.
    if (isVersionRequest(input)) {
      log.debug('Cache version read', { url: input.url, at: input.at, versions: input.versions });
      return readVersions({
        url: input.url,
        at: input.at,
        versions: input.versions,
        limit: input.limit,
        maxTokensOut: input.max_tokens_out,
      });
    }

    if (input.mode === 'hybrid' && input.query) {
      log.debug('Cache hybrid search', {
        query: input.query,
        limit: input.limit,
      });
      const { results } = await runHybridSearch({
        query: input.query,
        urlPattern: input.url_pattern,
        since: input.since,
        limit: input.limit,
      });
      return applyCacheOutputBudget(results, input.max_tokens_out);
    }

    log.debug('Cache search', {
      query: input.query,
      urlPattern: input.url_pattern,
      since: input.since,
      mode: input.mode,
      limit: input.limit,
    });
    const limit = input.limit ?? DEFAULT_CACHE_QUERY_LIMIT;
    const results = await runFtsCacheSearch({
      query: input.query ?? '',
      urlPattern: input.url_pattern,
      since: input.since,
      limit,
    });
    return applyCacheOutputBudget(results, input.max_tokens_out);
  } catch (err) {
    log.error('Cache tool error', { error: String(err) });
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
