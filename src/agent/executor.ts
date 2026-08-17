import { createLogger } from '../logger.js';
import { deduplicateResults, type MergedSearchResult } from '../search/dedup.js';
import { getExtractProvider } from '../providers/extract-provider.js';
import { isStageError } from '../fetch/error-describe.js';
import { isShellCapture } from '../extraction/completeness.js';
import { cacheContent } from '../cache/store.js';
import { rerankResults } from '../search/rerank.js';
import { rankAgentSearchResults } from './rank.js';
import { getConfig } from '../config.js';
import type { AgentPlan } from './planner.js';
import type { AgentSource, AgentStep, SearchEngine, RawSearchResult } from '../types.js';
import type { SmartRouter } from '../fetch/router.js';

const log = createLogger('agent');

const FETCH_TIMEOUT_MS = 15000;
const DEFAULT_RELEVANCE_THRESHOLD = 0.1;

export interface AgentSourceLike {
  url: string;
  title: string;
  body?: string;
  snippet?: string;
}

export interface ScoreFilterOptions {
  threshold: number;
}

export interface ExcludedSource<T extends AgentSourceLike = AgentSourceLike> {
  source: T;
  score: number;
  excluded_reason: string;
}

export function agentSourcesToSearchResults(sources: AgentSourceLike[]): MergedSearchResult[] {
  return sources.map((s) => ({
    title: s.title,
    url: s.url,
    snippet: s.snippet ?? s.body ?? '',
    relevance_score: 0,
    engines: ['agent'],
  }));
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

function tokenOverlapScore(query: string, source: AgentSourceLike): number {
  const qTokens = new Set(tokenize(query));
  if (qTokens.size === 0) return 0;
  const docText = `${source.title} ${source.body ?? ''} ${source.snippet ?? ''}`;
  const dTokens = tokenize(docText);
  if (dTokens.length === 0) return 0;
  let hits = 0;
  for (const t of dTokens) {
    if (qTokens.has(t)) hits++;
  }
  // Recall over query tokens: how many distinct query tokens appear in doc.
  const distinctHits = new Set(dTokens.filter((t) => qTokens.has(t))).size;
  const recall = distinctHits / qTokens.size;
  // Bias toward recall; light precision component prevents trivial 1.0.
  const precision = hits / dTokens.length;
  return Math.min(1, recall * 0.85 + precision * 0.15);
}

export async function scoreAndFilterSources<T extends AgentSourceLike>(
  prompt: string,
  sources: T[],
  opts: ScoreFilterOptions,
): Promise<{ kept: T[]; excluded: ExcludedSource<T>[] }> {
  if (sources.length === 0) return { kept: [], excluded: [] };

  const cfg = getConfig();
  const useReranker = cfg.reranker !== 'none';
  const scoreByUrl = new Map<string, number>();

  if (useReranker) {
    try {
      const merged = agentSourcesToSearchResults(sources);
      const ranked = await rerankResults(prompt, merged, { skip: false });
      for (const r of ranked) {
        scoreByUrl.set(r.url, r.relevance_score);
      }
    } catch (err) {
      log.warn('agent reranker failed, falling back to token overlap', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const kept: T[] = [];
  const excluded: ExcludedSource<T>[] = [];

  for (const source of sources) {
    let score = scoreByUrl.get(source.url);
    if (score === undefined) {
      // rerank dropped this URL via its internal threshold, OR rerank threw and we're
      // in the catch path — fall back to lightweight token-overlap so the source is
      // still scored.
      score = tokenOverlapScore(prompt, source);
    }
    if (score < opts.threshold) {
      excluded.push({
        source,
        score,
        excluded_reason: `below_threshold(${opts.threshold})`,
      });
    } else {
      kept.push(source);
    }
  }

  return { kept, excluded };
}

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
  prompt = '',
): Promise<ExecutionResult> {
  const steps: AgentStep[] = [];
  const allUrls = new Set<string>();

  try {
    // Phase 1: Seed allUrls with explicit URLs first so they get top priority
    // when budget.maxPages truncates the merged set.
    for (const url of plan.urls) {
      allUrls.add(url);
    }

    // Phase 2: Execute search queries
    if (plan.searches.length > 0) {
      const searchStart = Date.now();
      const searchResults = await executeSearches(plan.searches, engines, budget.deadlineMs, prompt);

      steps.push({
        action: 'search',
        detail: `Searched ${plan.searches.length} queries, found ${searchResults.length} results`,
        time_ms: Date.now() - searchStart,
      });

      for (const result of searchResults) {
        allUrls.add(result.url);
      }
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
      detail: describeFetchStep(sources, urlsToFetch.length),
      time_ms: Date.now() - fetchStart,
    });

    // Phase 4: Post-fetch relevance scoring
    // Only filter when a real reranker is configured; the token-overlap
    // fallback is too noisy to drop sources from on its own.
    const trimmedPrompt = prompt.trim();
    const cfg = getConfig();
    if (trimmedPrompt.length > 0 && cfg.reranker === 'none') {
      log.debug(
        'agent post-fetch relevance filter disabled (reranker=none); relying on pre-fetch filter only',
      );
    }
    if (trimmedPrompt.length > 0 && cfg.reranker !== 'none') {
      const fetched = sources.filter((s) => s.fetched && s.markdown_content.length > 0);
      const candidates: AgentSourceLike[] = fetched.map((s) => ({
        url: s.url,
        title: s.title,
        body: s.markdown_content,
      }));
      const { kept, excluded } = await scoreAndFilterSources(
        trimmedPrompt,
        candidates,
        { threshold: DEFAULT_RELEVANCE_THRESHOLD },
      );

      if (excluded.length > 0) {
        log.info('agent post-fetch relevance filter excluded sources', {
          excluded_count: excluded.length,
          kept_count: kept.length,
          excluded: excluded.map((e) => ({
            url: e.source.url,
            score: Number(e.score.toFixed(4)),
            excluded_reason: e.excluded_reason,
          })),
        });
      }

      const keptUrls = new Set(kept.map((k) => k.url));
      // Preserve unfetched sources (they were never candidates) plus kept fetched.
      const filteredSources = sources.filter(
        (s) => !s.fetched || s.markdown_content.length === 0 || keptUrls.has(s.url),
      );
      return { sources: filteredSources, steps };
    }

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
  rankPrompt = '',
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
  // Apply brand-collision rank (sub-ticket 2.7) so URLs are inserted into
  // the executor's fetch queue in domain-quality + lexical-alignment order.
  // The query used is the joined plan queries — the actual agent prompt is
  // re-applied post-fetch via scoreAndFilterSources / rerankResults.
  const rankQuery = rankPrompt.trim().length > 0 ? rankPrompt : queries.join(' ');
  const ranked = rankAgentSearchResults(rankQuery, merged);
  return ranked.map((m) => ({
    url: m.url,
    title: m.title,
    snippet: m.snippet,
    relevance_score: m.relevance_score,
  }));
}

/**
 * The `fetch` step is USER-VISIBLE — it is the only place the agent says what happened to the
 * pages it tried, and until refusals stopped taking the success path it could say "Fetched 5/5
 * pages" about five pages that were all declined. The count is now honest on its own; naming
 * the distinct reasons on top of it is what lets a reader tell a wall from an outage, which is
 * the difference between "try a different source" and "try again later".
 */
function describeFetchStep(sources: AgentSource[], attempted: number): string {
  const fetched = sources.filter((s) => s.fetched).length;
  const base = `Fetched ${fetched}/${attempted} pages`;
  const reasons = [
    ...new Set(
      sources
        .filter((s) => !s.fetched && typeof s.fetch_error === 'string' && s.fetch_error.length > 0)
        .map((s) => s.fetch_error as string),
    ),
  ];
  return reasons.length > 0 ? `${base} (not retrieved: ${reasons.join(', ')})` : base;
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

      // A REFUSED fetch has no `.html`, and the extractor returns empty markdown instead of
      // throwing on `undefined` — so a declined page used to enter the source list looking
      // fetched with nothing in it, and the step log just showed a smaller numerator with no
      // stated cause. Record the refusal so both the source AND the user-visible step can say
      // the page was declined rather than empty.
      if (isStageError(raw)) {
        log.debug('agent source refused', { url, error: raw.error, reason: raw.error_reason });
        return {
          url,
          title: '',
          markdown_content: '',
          // `fetched: false` is the load-bearing part — the step log and the all-failed
          // warning in pipeline.ts both count it, and a refusal taking the success path made
          // a fully blocked run report "Fetched 5/5 pages". The bare CODE goes in
          // `fetch_error` so a caller can branch on it; the prose is in the log above.
          fetched: false,
          fetch_error: raw.error,
        };
      }

      const extractor = await getExtractProvider();
      const extraction = await extractor.extract(raw.html, raw.finalUrl, {
        maxChars: 30000,
        contentType: raw.contentType,
      });

      try {
        cacheContent(raw, extraction);
      } catch (err) {
        log.debug('failed to cache agent source', { url, error: String(err) });
      }

      // Shell-completeness exclusion, mirroring research/pipeline.ts. A bot wall the challenge
      // classifier never flagged arrives as an ordinary successful fetch — no stage error to
      // catch — labelled `shell` because the page never rendered its content. Research already
      // refuses to cite those; the agent had no equivalent, so a wall's own text flowed into
      // synthesis as if it were the page. Marked `fetched: false` so it reaches the step log,
      // the all-failed warning and synthesis through the one path that already reports
      // non-retrieval, rather than a second mechanism beside it.
      //
      // Only an EXPLICIT `shell` level excludes: an unlabeled source (HTTP/TLS tier, which
      // never produces a render verdict at all) must not be swept up by a missing label.
      if (isShellCapture(raw, extraction)) {
        log.info('agent source excluded: capture never rendered content', { url });
        return {
          url,
          title: '',
          markdown_content: '',
          fetched: false,
          fetch_error: 'shell-content',
        };
      }

      return {
        url,
        title: extraction.title,
        markdown_content: extraction.markdown,
        // Carry raw HTML so schema extraction can read real table/definition/
        // microdata structures the markdown flattens away.
        rawHtml: raw.html,
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
