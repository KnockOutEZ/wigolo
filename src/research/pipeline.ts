import { createLogger } from '../logger.js';
import { decomposeQuestion } from './decompose.js';
import { synthesizeReport } from './synthesize.js';
import { deduplicateResults } from '../search/dedup.js';
import { rerankResults } from '../search/rerank.js';
import { applyAllFilters } from '../search/filters.js';
import { extractContent } from '../extraction/pipeline.js';
import { cacheContent } from '../cache/store.js';
import type { SamplingCapableServer } from '../search/sampling.js';
import type {
  ResearchInput,
  ResearchOutput,
  ResearchSource,
  SearchEngine,
  RawSearchResult,
} from '../types.js';
import type { SmartRouter } from '../fetch/router.js';

const log = createLogger('research');

const DEPTH_CONFIG: Record<string, { subQueries: number; minSources: number; maxSources: number }> = {
  quick: { subQueries: 2, minSources: 5, maxSources: 8 },
  standard: { subQueries: 4, minSources: 10, maxSources: 15 },
  comprehensive: { subQueries: 7, minSources: 20, maxSources: 25 },
};

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
    const subQueries = decomposeResult.subQueries;
    log.info('decomposition complete', { subQueryCount: subQueries.length, samplingUsed: decomposeResult.samplingUsed });

    // Phase 2: Parallel search across sub-queries
    const allRaw: RawSearchResult[] = [];
    const enginesUsed = new Set<string>();

    const searchPromises = engines.flatMap((engine) =>
      subQueries.map(async (query) => {
        try {
          const results = await engine.search(query, {
            maxResults: Math.ceil(maxSources / subQueries.length) * 2,
            includeDomains: input.include_domains,
            excludeDomains: input.exclude_domains,
          });
          for (const r of results) {
            allRaw.push(r);
            enginesUsed.add(engine.name);
          }
        } catch (err) {
          log.warn('search sub-query failed', {
            engine: engine.name,
            query,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }),
    );

    await Promise.allSettled(searchPromises);
    log.info('search phase complete', { totalRaw: allRaw.length, engines: [...enginesUsed] });

    // Phase 3: Deduplicate, filter, rerank
    let merged = deduplicateResults(allRaw);

    merged = applyAllFilters(merged, {
      includeDomains: input.include_domains,
      excludeDomains: input.exclude_domains,
    });

    merged = await rerankResults(input.question, merged);
    merged = merged.slice(0, maxSources);

    if (merged.length === 0) {
      return {
        report: `## Research: ${input.question}\n\nNo sources could be found for this query.`,
        citations: [],
        sources: [],
        sub_queries: subQueries,
        depth,
        total_time_ms: Date.now() - start,
        sampling_supported: !!server,
      };
    }

    // Phase 4: Fetch top sources in parallel
    const sources: ResearchSource[] = await fetchSources(merged, router, maxSources);
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

    return {
      report: synthesisResult.report,
      citations: synthesisResult.citations,
      sources,
      sub_queries: subQueries,
      depth,
      total_time_ms: Date.now() - start,
      sampling_supported: !!server,
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
      sampling_supported: !!server,
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
  merged: MergedResult[],
  router: SmartRouter,
  maxSources: number,
): Promise<ResearchSource[]> {
  const fetchPromises = merged.slice(0, maxSources).map(async (result): Promise<ResearchSource> => {
    try {
      const raw = await Promise.race([
        router.fetch(result.url, { renderJs: 'auto' }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('fetch timeout')), 15000),
        ),
      ]);

      const extraction = await extractContent(raw.html, raw.finalUrl, {
        maxChars: 30000,
        contentType: raw.contentType,
      });

      try {
        cacheContent(raw, extraction);
      } catch (err) {
        log.debug('failed to cache research source', { url: result.url, error: String(err) });
      }

      return {
        url: result.url,
        title: extraction.title || result.title,
        markdown_content: extraction.markdown,
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
