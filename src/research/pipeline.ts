import { createLogger } from '../logger.js';
import { decomposeQuestion, detectQueryType, extractComparisonEntities, type QueryType } from './decompose.js';
import { synthesizeReport } from './synthesize.js';
import { buildResearchBrief } from './brief.js';
import { deduplicateResults } from '../search/dedup.js';
import { rerankResults } from '../search/rerank.js';
import { applyAllFilters } from '../search/filters.js';
import { fanOutSearch } from '../search/multi-query.js';
import { extractContent } from '../extraction/pipeline.js';
import { truncateSmartly } from '../search/truncate.js';
import { cacheContent } from '../cache/store.js';
import { getEmbeddingService } from '../embedding/embed.js';
import { checkSamplingSupport, type SamplingCapableServer } from '../search/sampling.js';
import type {
  ResearchInput,
  ResearchOutput,
  ResearchSource,
  SearchEngine,
} from '../types.js';
import type { SmartRouter } from '../fetch/router.js';

const log = createLogger('research');

const DEPTH_CONFIG: Record<string, { subQueries: number; minSources: number; maxSources: number }> = {
  quick: { subQueries: 2, minSources: 5, maxSources: 8 },
  standard: { subQueries: 4, minSources: 10, maxSources: 15 },
  comprehensive: { subQueries: 7, minSources: 20, maxSources: 25 },
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
    const subQueries = decomposeResult.subQueries;
    const queryType = decomposeResult.queryType;
    log.info('decomposition complete', { subQueryCount: subQueries.length, samplingUsed: decomposeResult.samplingUsed, queryType });

    // Phase 2: Parallel search across sub-queries via multi-query fan-out
    const { results: allRaw, enginesUsed: enginesUsedArr, errors: searchErrors } = await fanOutSearch(
      subQueries,
      engines,
      {
        maxResults: Math.ceil(maxSources / subQueries.length) * 2,
        includeDomains: input.include_domains,
        excludeDomains: input.exclude_domains,
      },
    );

    if (searchErrors.length > 0) {
      log.warn('some search sub-queries failed', { errors: searchErrors });
    }

    const enginesUsed = new Set<string>(enginesUsedArr);
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
        sampling_supported: !!server && checkSamplingSupport(server),
      };
    }

    // Phase 4: Fetch top sources in parallel
    const sources: ResearchSource[] = await fetchSources(merged, router, maxSources);
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
        )
      : undefined;

    return {
      report: synthesisResult.report,
      citations: synthesisResult.citations,
      sources,
      sub_queries: subQueries,
      depth,
      total_time_ms: Date.now() - start,
      sampling_supported: !!server && checkSamplingSupport(server),
      ...(brief ? { brief } : {}),
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
