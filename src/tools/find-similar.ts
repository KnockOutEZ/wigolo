import type {
  FindSimilarInput,
  FindSimilarOutput,
  SearchEngine,
  EvidenceItem,
  StageResult,
} from '../types.js';
import type { SmartRouter } from '../fetch/router.js';
import type { BackendStatus } from '../server/backend-status.js';
import { findSimilar } from '../search/find-similar.js';
import {
  buildEvidenceFromMarkdown,
  applyTokenBudget,
  applyAggregateMarkdownBudget,
} from '../search/evidence.js';
import * as cacheStore from '../cache/store.js';
import * as searchTool from './search.js';
import { createLogger } from '../logger.js';

const log = createLogger('search');

const MAX_RESULTS_CAP = 50;
const DEFAULT_MAX_TOKENS_OUT = 4000;

export async function handleFindSimilar(
  input: FindSimilarInput,
  engines: SearchEngine[],
  router: SmartRouter,
  backendStatus?: BackendStatus,
): Promise<StageResult<FindSimilarOutput>> {
  try {
    const url = input.url?.trim();
    const concept = input.concept?.trim();

    if (!url && !concept) {
      return {
        ok: false,
        error: 'invalid_input',
        error_reason: 'Either url or concept must be provided',
        stage: 'find_similar',
      };
    }

    const sanitizedInput: FindSimilarInput = {
      ...input,
      max_results: input.max_results
        ? Math.min(input.max_results, MAX_RESULTS_CAP)
        : undefined,
    };

    log.info('find_similar request', {
      hasUrl: !!url,
      hasConcept: !!concept,
      maxResults: sanitizedInput.max_results,
      includeCache: sanitizedInput.include_cache,
      includeWeb: sanitizedInput.include_web,
    });

    let cacheSeeded = false;
    if (url) {
      try {
        const u = new URL(url);
        const host = u.hostname;
        const cachedCount = cacheStore.countCachedUrlsForDomain(host);
        if (cachedCount < 5) {
          const rawSeg = u.pathname.split('/').filter(Boolean).pop() ?? '';
          let lastSeg = rawSeg;
          try { lastSeg = decodeURIComponent(rawSeg); } catch { /* leave raw */ }
          const seedQuery = (
            lastSeg.replace(/[-_]/g, ' ') +
            ' ' +
            host.replace(/^www\./, '').split('.')[0]
          ).trim();
          if (seedQuery.length > 0) {
            try {
              await searchTool.handleSearch(
                { query: seedQuery },
                engines,
                router,
                backendStatus,
              );
              cacheSeeded = true;
            } catch (seedErr) {
              log.warn('find_similar cold-start seed failed', {
                error: seedErr instanceof Error ? seedErr.message : String(seedErr),
              });
            }
          }
        }
      } catch (parseErr) {
        log.warn('find_similar cold-start url parse failed', {
          error: parseErr instanceof Error ? parseErr.message : String(parseErr),
        });
      }
    }

    const _start = Date.now();
    const out = await findSimilar(sanitizedInput, engines, router, backendStatus);
    await attachEvidence(out, input);
    if (cacheSeeded) out.cache_seeded = true;
    out.response_time_ms = Date.now() - _start;
    if (out.error) {
      return {
        ok: false,
        error: out.error,
        error_reason: out.error,
        stage: 'find_similar',
      };
    }
    return { ok: true, data: out };
  } catch (err) {
    log.error('handleFindSimilar failed', { error: String(err) });
    return {
      ok: false,
      error: 'find_similar_failed',
      error_reason: `find_similar handler error: ${err instanceof Error ? err.message : String(err)}`,
      stage: 'find_similar',
    };
  }
}

async function attachEvidence(
  out: FindSimilarOutput,
  input: FindSimilarInput,
): Promise<void> {
  if (out.results.length === 0) return;
  const includeFull = input.include_full_markdown ?? false;
  const maxTokensOut = input.max_tokens_out ?? DEFAULT_MAX_TOKENS_OUT;
  const query = input.concept?.trim() || input.url?.trim() || out.results[0].title;

  const collected: EvidenceItem[] = [];
  for (const r of out.results) {
    if (!r.markdown) continue;
    const evs = await buildEvidenceFromMarkdown(query, r.title, r.url, r.markdown, {
      maxItems: 1,
    });
    collected.push(...evs);
  }

  const budgeted = applyTokenBudget(collected, maxTokensOut);
  if (budgeted.length > 0) out.evidence = budgeted;

  if (!includeFull) {
    for (const r of out.results) {
      r.markdown = '';
    }
  } else {
    applyAggregateMarkdownBudget(
      out.results,
      (r) => r.markdown ?? '',
      (r, body) => { r.markdown = body; },
      { maxTokensOut },
    );
  }
}
