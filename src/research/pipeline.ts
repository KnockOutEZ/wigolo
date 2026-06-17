import { createLogger } from '../logger.js';
import { decomposeQuestion, detectQueryType, extractComparisonEntities, type QueryType } from './decompose.js';
import { synthesizeReport } from './synthesize.js';
import { synthesizeLocal } from './synthesis-local.js';
import { buildResearchBrief } from './brief.js';
import { renderBriefReport } from './render-brief.js';
import { deduplicateResults } from '../search/dedup.js';
import { rerankResults } from '../search/rerank.js';
import { applyAllFilters } from '../search/filters.js';
import { classifyUrlShape, classifyScoreFloor, queryContentTerms, gateContent } from './source-validation.js';
import { exploreInParallel } from './branch-exploration.js';
import type { RawSearchResult, SearchEngineOptions } from '../types.js';
import { getExtractProvider } from '../providers/extract-provider.js';
import { truncateSmartly } from '../search/truncate.js';
import { cacheContent } from '../cache/store.js';
import { getEmbeddingService } from '../embedding/embed.js';
import { checkSamplingSupport, type SamplingCapableServer } from '../search/sampling.js';
import { isLlmConfiguredWithKeyStore } from '../integrations/cloud/llm/run.js';
import type {
  ResearchInput,
  ResearchOutput,
  ResearchSource,
  RejectedSource,
  SearchEngine,
  Citation,
} from '../types.js';
import type { SmartRouter } from '../fetch/router.js';

const log = createLogger('research');

const DEPTH_CONFIG: Record<string, { subQueries: number; minSources: number; maxSources: number }> = {
  quick: { subQueries: 2, minSources: 5, maxSources: 8 },
  standard: { subQueries: 4, minSources: 10, maxSources: 15 },
  comprehensive: { subQueries: 7, minSources: 20, maxSources: 25 },
};

// Per-depth budgets for the sub-query fan-out. exploreInParallel guarantees
// a single slow sub-query can't burn the whole research budget — comprehensive
// runs cap at ~60s total and 15s per sub-query.
const SEARCH_TOTAL_BUDGET_MS: Record<string, number> = {
  quick: 15_000,
  standard: 30_000,
  comprehensive: 60_000,
};
const SEARCH_PER_QUERY_BUDGET_MS: Record<string, number> = {
  quick: 8_000,
  standard: 10_000,
  comprehensive: 15_000,
};

const PER_SOURCE_CHAR_CAP = 3000;
const TOTAL_SOURCES_CHAR_CAP = 40000;

export async function runResearchPipeline(
  input: ResearchInput,
  engines: SearchEngine[],
  router: SmartRouter,
  server?: SamplingCapableServer,
): Promise<ResearchOutput> {
  const start = Date.now();
  const depth = input.depth ?? 'standard';
  const config = DEPTH_CONFIG[depth] ?? DEPTH_CONFIG.standard;
  const maxSources = input.max_sources ?? config.maxSources;

  try {
    // Phase 1: Decompose question into sub-queries
    log.info('research pipeline started', { question: input.question, depth });
    const decomposeResult = await decomposeQuestion(
      input.question,
      depth as 'quick' | 'standard' | 'comprehensive',
      server,
    );
    // The decomposer rewrites the question into a synthetic sub-query set —
    // useful for breadth but it loses specific tokens from the original
    // phrasing (the bench called this the "A2A clause drop": "Anthropic A2A
    // vs Swarm" had "A2A" stripped during noun-phrase extraction). Prepend
    // the original verbatim so the seed phrasing always feeds the search
    // fan-out, dedup'd case-insensitively against the synthetic set.
    const subQueries = (() => {
      const original = input.question.trim();
      if (!original) return decomposeResult.subQueries;
      const seen = new Set(decomposeResult.subQueries.map((q) => q.toLowerCase()));
      if (seen.has(original.toLowerCase())) return decomposeResult.subQueries;
      return [original, ...decomposeResult.subQueries];
    })();
    const queryType = decomposeResult.queryType;
    log.info('decomposition complete', { subQueryCount: subQueries.length, samplingUsed: decomposeResult.samplingUsed, queryType });

    // Phase 2: Parallel search across sub-queries with per-query + total
    // budget enforcement via exploreInParallel. A single hung engine no
    // longer wedges the whole research call — the per-query timer aborts
    // it and the rest of the fan-out keeps going. Engine cap when
    // sub-queries are many preserves the multi-query.ts invariant.
    const effEngines = subQueries.length >= 3 && engines.length > 2 ? engines.slice(0, 2) : engines;
    const perEngineMaxResults = Math.ceil(maxSources / subQueries.length) * 2;

    const branchResults = await exploreInParallel(
      subQueries,
      async (subQuery, signal) => {
        const results: RawSearchResult[] = [];
        const usedHere = new Set<string>();
        const engineOpts: SearchEngineOptions = {
          maxResults: perEngineMaxResults,
          includeDomains: input.include_domains,
          excludeDomains: input.exclude_domains,
        };

        await Promise.allSettled(
          effEngines.map(async (engine) => {
            if (signal.aborted) return;
            try {
              const rs = await engine.search(subQuery, engineOpts);
              for (const r of rs) results.push(r);
              usedHere.add(engine.name);
            } catch (err) {
              log.warn('research engine search failed', {
                engine: engine.name,
                query: subQuery,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }),
        );

        return { results, enginesUsed: [...usedHere] };
      },
      {
        maxConcurrent: 3,
        totalBudgetMs: SEARCH_TOTAL_BUDGET_MS[depth] ?? SEARCH_TOTAL_BUDGET_MS.standard,
        perQueryBudgetMs: SEARCH_PER_QUERY_BUDGET_MS[depth] ?? SEARCH_PER_QUERY_BUDGET_MS.standard,
      },
    );

    const allRaw: RawSearchResult[] = [];
    const enginesUsed = new Set<string>();
    const searchErrors: string[] = [];
    for (const br of branchResults) {
      if (br.ok && br.result) {
        allRaw.push(...br.result.results);
        for (const e of br.result.enginesUsed) enginesUsed.add(e);
      } else if (br.error) {
        searchErrors.push(`${br.query}: ${br.error}`);
      }
    }
    if (searchErrors.length > 0) {
      log.warn('some search sub-queries failed', { errors: searchErrors });
    }

    log.info('search phase complete', { totalRaw: allRaw.length, engines: [...enginesUsed] });

    // Phase 3: Deduplicate, filter, rerank
    let merged = deduplicateResults(allRaw);

    merged = applyAllFilters(merged, {
      includeDomains: input.include_domains,
      excludeDomains: input.exclude_domains,
    });

    merged = await rerankResults(input.question, merged);

    const rejected_sources: RejectedSource[] = [];

    // Score floor — the cheap pre-filter that runs BEFORE the url-shape loop.
    // The cross-encoder scores off-topic real-content domains (benchmark C1:
    // YouTube / Google Play / Zhihu / MyBroadband) below zero; url-shape and
    // the content gate both pass them because they ARE real, on-domain pages.
    // Dropping negatives here closes that gap. merged is sorted desc by score,
    // so merged[0] is the top — always keep it so the pool is never emptied
    // when the reranker damped everything below zero.
    const scoreKept: MergedResult[] = [];
    for (let i = 0; i < merged.length; i++) {
      const m = merged[i];
      const verdict = i === 0 ? { reject: false } : classifyScoreFloor(m.relevance_score);
      if (verdict.reject && verdict.reason) {
        rejected_sources.push({ url: m.url, reason: verdict.reason, stage: 'score-floor' });
      } else {
        scoreKept.push(m);
      }
    }

    // Source validation (url-shape) — drop homepage/SERP candidates BEFORE the
    // slice so the next-ranked legitimate candidate back-fills the freed slot.
    // Rejected URLs are surfaced in rejected_sources, never silently swallowed.
    const urlKept: MergedResult[] = [];
    for (const m of scoreKept) {
      const verdict = classifyUrlShape(m.url, input.include_domains);
      if (verdict.reject && verdict.reason) {
        rejected_sources.push({ url: m.url, reason: verdict.reason, stage: 'url-shape' });
      } else {
        urlKept.push(m);
      }
    }

    if (urlKept.length === 0) {
      return {
        report: `## Research: ${input.question}\n\nNo sources could be found for this query.`,
        citations: [],
        sources: [],
        sub_queries: subQueries,
        depth,
        total_time_ms: Date.now() - start,
        sampling_supported: !!server && checkSamplingSupport(server),
        ...(rejected_sources.length > 0 ? { rejected_sources } : {}),
      };
    }

    // Over-fetch a small buffer beyond maxSources so the post-fetch content
    // gate can drop empty shells and still back-fill to maxSources.
    const buffer = Math.min(
      Math.max(urlKept.length - maxSources, 0),
      Math.ceil(maxSources * 0.4),
    );
    const toFetch = urlKept.slice(0, maxSources + buffer);

    // Phase 4: Fetch the buffered candidate set in parallel
    const fetched: ResearchSource[] = await fetchSources(router, toFetch);

    // Content gate — drop empty/off-topic shells (thin AND off-topic). Only
    // successfully-fetched content is gated: a fetch failure keeps the search
    // snippet as a deliberate fallback (not the gate's target — empty shells
    // are pages that fetched but returned nothing).
    const queryTerms = queryContentTerms(input.question);
    const gated: ResearchSource[] = [];
    const contentRejects: RejectedSource[] = [];
    for (const s of fetched) {
      if (s.fetched) {
        const verdict = gateContent(s.markdown_content, queryTerms);
        if (verdict.reject && verdict.reason) {
          contentRejects.push({ url: s.url, reason: verdict.reason, stage: 'content-gate' });
          continue;
        }
      }
      gated.push(s);
    }
    // Fail open — never let the content gate empty the result; mediocre
    // sources beat no sources (rerank already ordered them).
    let sources: ResearchSource[];
    if (gated.length > 0) {
      sources = gated.slice(0, maxSources);
      rejected_sources.push(...contentRejects);
    } else {
      sources = fetched.slice(0, maxSources);
    }
    applySourceBudget(sources, PER_SOURCE_CHAR_CAP, TOTAL_SOURCES_CHAR_CAP);
    log.info('fetch phase complete', {
      fetched: sources.filter((s) => s.fetched).length,
      failed: sources.filter((s) => !s.fetched).length,
    });

    // Phase 5: Synthesize report
    const synthesisResult = await synthesizeReport(
      input.question,
      sources,
      depth as 'quick' | 'standard' | 'comprehensive',
      server,
    );
    log.info('synthesis complete', { samplingUsed: synthesisResult.samplingUsed, reportLength: synthesisResult.report.length });

    // Phase 5b: Local-LLM synthesis fallback — only when host LLM did not
    // produce output AND a local provider is configured. Failures fall through
    // to the existing heuristic report in synthesisResult.
    let finalReport = synthesisResult.report;
    let finalCitations: Citation[] = synthesisResult.citations;
    let localSynthesisText: string | undefined;
    let localSynthesisSucceeded = false;
    if (!synthesisResult.samplingUsed && await isLlmConfiguredWithKeyStore()) {
      try {
        const localSources = sources
          .filter((s) => s.fetched && s.markdown_content.length > 0)
          .map((s) => ({ url: s.url, title: s.title, markdown: s.markdown_content }));
        if (localSources.length > 0) {
          const local = await synthesizeLocal(input.question, localSources);
          finalReport = local.text;
          localSynthesisText = local.text;
          localSynthesisSucceeded = true;
          finalCitations = local.citations
            .filter((idx) => idx >= 0 && idx < localSources.length)
            .map((idx) => {
              const s = localSources[idx];
              return {
                index: idx + 1,
                url: s.url,
                title: s.title,
                snippet: s.markdown.slice(0, 200),
              };
            });
          log.info('local synthesis succeeded', { reportLength: finalReport.length });
        }
      } catch (err) {
        log.warn('local LLM synthesis failed; using heuristic fallback', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Phase 6: Structured brief — populated when internal sampling is
    // unavailable so the host LLM has well-shaped data to write the report
    // from without re-reading raw markdown.
    const comparisonEntities = queryType === 'comparison'
      ? extractComparisonEntities(input.question).entities
      : [];
    const brief = !synthesisResult.samplingUsed
      ? await buildResearchBrief(
          input.question,
          sources,
          subQueries,
          PER_SOURCE_CHAR_CAP,
          TOTAL_SOURCES_CHAR_CAP,
          queryType,
          comparisonEntities,
          localSynthesisText,
        )
      : undefined;

    // Keyless template mode: when neither host-LLM sampling nor a local LLM
    // produced the report, weave the structured brief into an organized,
    // source-cited document instead of returning the flat per-source dump.
    // The sampling path and the successful-local-LLM path keep their own
    // report; buildFallbackReport remains the safety net when no brief exists.
    if (!synthesisResult.samplingUsed && !localSynthesisSucceeded && brief) {
      finalReport = renderBriefReport(input.question, brief, sources);
    }

    return {
      report: finalReport,
      citations: finalCitations,
      sources,
      sub_queries: subQueries,
      depth,
      total_time_ms: Date.now() - start,
      sampling_supported: !!server && checkSamplingSupport(server),
      ...(brief ? { brief } : {}),
      ...(rejected_sources.length > 0 ? { rejected_sources } : {}),
    };
  } catch (err) {
    log.error('research pipeline failed', {
      question: input.question,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      report: '',
      citations: [],
      sources: [],
      sub_queries: [],
      depth,
      total_time_ms: Date.now() - start,
      sampling_supported: !!server && checkSamplingSupport(server),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

interface MergedResult {
  title: string;
  url: string;
  snippet: string;
  relevance_score: number;
  engines: string[];
}

async function fetchSources(
  router: SmartRouter,
  merged: MergedResult[],
): Promise<ResearchSource[]> {
  const fetchPromises = merged.map(async (result): Promise<ResearchSource> => {
    try {
      const raw = await Promise.race([
        router.fetch(result.url, { renderJs: 'auto' }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('fetch timeout')), 15000),
        ),
      ]);

      const extractor = await getExtractProvider();
      const extraction = await extractor.extract(raw.html, raw.finalUrl, {
        maxChars: 30000,
        contentType: raw.contentType,
      });
      const truncated = truncateSmartly(extraction.markdown, PER_SOURCE_CHAR_CAP);

      try {
        cacheContent(raw, extraction);
      } catch (err) {
        log.warn('failed to cache research source', { url: result.url, error: String(err) });
      }

      try {
        const embeddingService = getEmbeddingService();
        if (embeddingService.isAvailable()) {
          embeddingService.embedAsync(raw.finalUrl, extraction.markdown);
        }
      } catch (err) {
        log.debug('embedding hook skipped for research source', { error: String(err) });
      }

      return {
        url: result.url,
        title: extraction.title || result.title,
        markdown_content: truncated,
        relevance_score: result.relevance_score,
        fetched: true,
      };
    } catch (err) {
      log.debug('failed to fetch research source', {
        url: result.url,
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        url: result.url,
        title: result.title,
        markdown_content: result.snippet,
        relevance_score: result.relevance_score,
        fetched: false,
        fetch_error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  return Promise.all(fetchPromises);
}

// Cap total returned markdown_content across sources in relevance order.
// Later (lower-relevance) sources get trimmed further when budget runs low;
// any source past the cap is set to empty content (caller still sees url/title).
function applySourceBudget(
  sources: ResearchSource[],
  perSourceCap: number,
  totalCap: number,
): void {
  let used = 0;
  for (const s of sources) {
    if (!s.markdown_content) continue;
    if (used >= totalCap) {
      s.markdown_content = '';
      continue;
    }
    const remaining = totalCap - used;
    const cap = Math.min(perSourceCap, remaining);
    if (s.markdown_content.length > cap) {
      s.markdown_content = truncateSmartly(s.markdown_content, cap);
    }
    used += s.markdown_content.length;
  }
}
