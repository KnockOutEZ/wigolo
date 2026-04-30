import type {
  FindSimilarInput,
  FindSimilarOutput,
  SearchEngine,
  EvidenceItem,
} from '../types.js';
import type { SmartRouter } from '../fetch/router.js';
import type { BackendStatus } from '../server/backend-status.js';
import { findSimilar } from '../search/find-similar.js';
import { buildEvidenceFromMarkdown, applyTokenBudget } from '../search/evidence.js';
import { countTokens } from '../search/tokens.js';
import { applyOutputBudget } from '../search/truncate.js';
import { createLogger } from '../logger.js';

const log = createLogger('search');

const MAX_RESULTS_CAP = 50;
const DEFAULT_MAX_TOKENS_OUT = 4000;

export async function handleFindSimilar(
  input: FindSimilarInput,
  engines: SearchEngine[],
  router: SmartRouter,
  backendStatus?: BackendStatus,
): Promise<FindSimilarOutput> {
  try {
    const url = input.url?.trim();
    const concept = input.concept?.trim();

    if (!url && !concept) {
      return {
        results: [],
        method: 'fts5',
        cache_hits: 0,
        search_hits: 0,
        embedding_available: false,
        error: 'Either url or concept must be provided',
        total_time_ms: 0,
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

    const out = await findSimilar(sanitizedInput, engines, router, backendStatus);
    await attachEvidence(out, input);
    return out;
  } catch (err) {
    log.error('handleFindSimilar failed', { error: String(err) });
    return {
      results: [],
      method: 'fts5',
      cache_hits: 0,
      search_hits: 0,
      embedding_available: false,
      error: `find_similar handler error: ${err instanceof Error ? err.message : String(err)}`,
      total_time_ms: 0,
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
    let used = 0;
    for (const r of out.results) {
      if (!r.markdown) continue;
      const remaining = maxTokensOut - used;
      if (remaining <= 0) {
        r.markdown = '';
        continue;
      }
      r.markdown = applyOutputBudget(r.markdown, { maxTokensOut: remaining });
      used += countTokens(r.markdown);
    }
  }
}
