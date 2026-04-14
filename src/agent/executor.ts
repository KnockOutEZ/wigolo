import { createLogger } from '../logger.js';
import { deduplicateResults } from '../search/dedup.js';
import { extractContent } from '../extraction/pipeline.js';
import { cacheContent } from '../cache/store.js';
import type { AgentPlan } from './planner.js';
import type { AgentSource, AgentStep, SearchEngine, RawSearchResult } from '../types.js';
import type { SmartRouter } from '../fetch/router.js';

const log = createLogger('agent');

const FETCH_TIMEOUT_MS = 15000;

export interface ExecutionBudget {
  maxPages: number;
  deadlineMs: number;
}

export interface ExecutionResult {
  sources: AgentSource[];
  steps: AgentStep[];
}

export async function executeAgentPlan(
  plan: AgentPlan,
  engines: SearchEngine[],
  router: SmartRouter,
  budget: ExecutionBudget,
): Promise<ExecutionResult> {
  const steps: AgentStep[] = [];
  const allUrls = new Set<string>();

  try {
    // Phase 1: Execute search queries
    if (plan.searches.length > 0) {
      const searchStart = Date.now();
      const searchResults = await executeSearches(plan.searches, engines, budget.deadlineMs);

      steps.push({
        action: 'search',
        detail: `Searched ${plan.searches.length} queries, found ${searchResults.length} results`,
        time_ms: Date.now() - searchStart,
      });

      for (const result of searchResults) {
        allUrls.add(result.url);
      }
    }

    // Phase 2: Add explicit URLs
    for (const url of plan.urls) {
      allUrls.add(url);
    }

    if (allUrls.size === 0) {
      return { sources: [], steps };
    }

    // Phase 3: Fetch pages within budget
    const urlsToFetch = [...allUrls].slice(0, budget.maxPages);
    const fetchStart = Date.now();
    const sources = await fetchPages(urlsToFetch, router, budget);

    steps.push({
      action: 'fetch',
      detail: `Fetched ${sources.filter((s) => s.fetched).length}/${urlsToFetch.length} pages`,
      time_ms: Date.now() - fetchStart,
    });

    return { sources, steps };
  } catch (err) {
    log.error('execution failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { sources: [], steps };
  }
}

async function executeSearches(
  queries: string[],
  engines: SearchEngine[],
  deadlineMs: number,
): Promise<Array<{ url: string; title: string; snippet: string; relevance_score: number }>> {
  const allRaw: RawSearchResult[] = [];

  const searchPromises = engines.flatMap((engine) =>
    queries.map(async (query) => {
      if (Date.now() >= deadlineMs) return;

      try {
        const results = await engine.search(query, { maxResults: 10 });
        for (const r of results) {
          allRaw.push(r);
        }
      } catch (err) {
        log.warn('agent search query failed', {
          engine: engine.name,
          query,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }),
  );

  await Promise.allSettled(searchPromises);

  const merged = deduplicateResults(allRaw);
  return merged.map((m) => ({
    url: m.url,
    title: m.title,
    snippet: m.snippet,
    relevance_score: m.relevance_score,
  }));
}

async function fetchPages(
  urls: string[],
  router: SmartRouter,
  budget: ExecutionBudget,
): Promise<AgentSource[]> {
  const fetchPromises = urls.map(async (url): Promise<AgentSource> => {
    if (Date.now() >= budget.deadlineMs) {
      return {
        url,
        title: '',
        markdown_content: '',
        fetched: false,
        fetch_error: 'budget exceeded',
      };
    }

    try {
      const timeRemaining = budget.deadlineMs - Date.now();
      const fetchTimeout = Math.min(FETCH_TIMEOUT_MS, Math.max(timeRemaining, 1000));

      const raw = await Promise.race([
        router.fetch(url, { renderJs: 'auto' }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('fetch timeout')), fetchTimeout),
        ),
      ]);

      const extraction = await extractContent(raw.html, raw.finalUrl, {
        maxChars: 30000,
        contentType: raw.contentType,
      });

      try {
        cacheContent(raw, extraction);
      } catch (err) {
        log.debug('failed to cache agent source', { url, error: String(err) });
      }

      return {
        url,
        title: extraction.title,
        markdown_content: extraction.markdown,
        fetched: true,
      };
    } catch (err) {
      log.debug('agent fetch failed', {
        url,
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        url,
        title: '',
        markdown_content: '',
        fetched: false,
        fetch_error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  return Promise.all(fetchPromises);
}
