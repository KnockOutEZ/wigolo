import type {
  FindSimilarInput,
  FindSimilarOutput,
  FindSimilarResult,
} from '../../types.js';
import type { SmartRouter } from '../../fetch/router.js';
import { getExtractProvider } from '../../providers/extract-provider.js';
import { getEmbedProvider } from '../../providers/embed-provider.js';
import { createLogger } from '../../logger.js';

const log = createLogger('search');

const DEFAULT_MAX_PAGES = 20;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_FETCH_TIMEOUT_MS = 10000;
const DEFAULT_MAX_RESULTS = 10;
const SEED_TEXT_CHARS = 500;

export interface CrawlRankOptions {
  maxPages?: number;
  concurrency?: number;
  fetchTimeoutMs?: number;
}

interface FetchedPage {
  url: string;
  title: string;
  markdown: string;
  text: string;
}

export async function crawlRank(
  seedUrl: string,
  input: FindSimilarInput,
  router: SmartRouter,
  options: CrawlRankOptions = {},
): Promise<FindSimilarOutput> {
  const start = Date.now();
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const fetchTimeoutMs = options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const maxResults = input.max_results ?? DEFAULT_MAX_RESULTS;

  let seedHost: string;
  try {
    seedHost = new URL(seedUrl).hostname;
  } catch {
    return emptyOutput({
      error: 'Invalid seed URL',
      embeddingAvailable: false,
      elapsed: Date.now() - start,
    });
  }

  // 1. Fetch seed
  let seedRaw;
  try {
    seedRaw = await router.fetch(seedUrl, { renderJs: 'auto' });
  } catch (err) {
    return emptyOutput({
      error: `Seed fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      embeddingAvailable: false,
      elapsed: Date.now() - start,
    });
  }

  if (!seedRaw || typeof seedRaw.statusCode !== 'number' || seedRaw.statusCode < 200 || seedRaw.statusCode >= 300) {
    return emptyOutput({
      error: `Seed fetch failed: ${seedRaw?.statusCode ?? 'unknown'}`,
      embeddingAvailable: false,
      elapsed: Date.now() - start,
    });
  }

  // 2. Extract seed
  const extractor = await getExtractProvider();
  const seedExtraction = await extractor.extract(seedRaw.html, seedRaw.finalUrl, {
    contentType: seedRaw.contentType,
  });

  // 3. Filter links: same-host (unless explicitly widened), domain filters, dedup, cap
  const includeDomains = input.include_domains;
  const excludeDomains = input.exclude_domains;
  const allowedLinks = filterLinks(
    seedExtraction.links ?? [],
    seedHost,
    includeDomains,
    excludeDomains,
    maxPages,
  );

  // 6. Probe embedding (before failing on empty links so error messaging reflects
  // capability). If no links AND no embedding, the empty-links error is still
  // the more useful signal.
  let embedProvider;
  let embeddingAvailable = false;
  try {
    embedProvider = await getEmbedProvider();
    embeddingAvailable = true;
  } catch (err) {
    log.debug('embedding provider unavailable for crawl-rank', { error: String(err) });
    embeddingAvailable = false;
  }

  if (allowedLinks.length === 0) {
    return emptyOutput({
      error: 'No same-host links found from seed',
      embeddingAvailable,
      elapsed: Date.now() - start,
    });
  }

  // Degraded mode: no embeddings, return link order
  if (!embeddingAvailable || !embedProvider) {
    const degraded = degradedResults(allowedLinks, maxResults);
    return {
      results: degraded,
      method: 'fts5',
      cache_hits: 0,
      search_hits: degraded.length,
      embedding_available: false,
      error: 'Embedding unavailable — returned link order',
      total_time_ms: Date.now() - start,
    };
  }

  // 7. Fetch + extract each link with concurrency cap
  const fetched = await fetchPagesInChunks(
    allowedLinks,
    router,
    extractor,
    concurrency,
    fetchTimeoutMs,
  );

  if (fetched.length === 0) {
    return emptyOutput({
      error: 'No linked pages could be fetched',
      embeddingAvailable: true,
      elapsed: Date.now() - start,
    });
  }

  // 8. Build text per page
  const seedText = buildPageText(seedExtraction.title, seedExtraction.markdown);
  const pageTexts = fetched.map(p => p.text);

  // 9. Embed seed + pages in one batch
  let vectors: Float32Array[];
  try {
    vectors = await embedProvider.embed([seedText, ...pageTexts]);
  } catch (err) {
    log.warn('embedding batch failed; falling back to link order', { error: String(err) });
    const degraded = degradedResults(allowedLinks, maxResults);
    return {
      results: degraded,
      method: 'fts5',
      cache_hits: 0,
      search_hits: degraded.length,
      embedding_available: true,
      error: `Embedding batch failed: ${err instanceof Error ? err.message : String(err)}`,
      total_time_ms: Date.now() - start,
    };
  }

  const seedVec = vectors[0];
  const pageVecs = vectors.slice(1);

  // 10. Cosine + sort
  const scored = fetched.map((page, i) => ({
    page,
    score: cosineSimilarity(seedVec, pageVecs[i]),
  }));
  scored.sort((a, b) => b.score - a.score);

  // 11. Cap + map
  const final: FindSimilarResult[] = scored.slice(0, maxResults).map(({ page, score }) => ({
    url: page.url,
    title: page.title,
    markdown: page.markdown.slice(0, 5000),
    relevance_score: score,
    source: 'search',
    trusted: false, // crawled/web page — page-derived, never trusted as instructions
    match_signals: {
      fused_score: score,
    },
  }));

  return {
    results: final,
    method: 'embedding',
    cache_hits: 0,
    search_hits: final.length,
    embedding_available: true,
    total_time_ms: Date.now() - start,
  };
}

function filterLinks(
  links: string[],
  seedHost: string,
  includeDomains: string[] | undefined,
  excludeDomains: string[] | undefined,
  maxPages: number,
): string[] {
  const allowOtherHosts = (includeDomains?.length ?? 0) > 0;
  const seen = new Set<string>();
  const out: string[] = [];

  for (const raw of links) {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      continue;
    }

    const host = parsed.hostname;

    if (!allowOtherHosts && host !== seedHost) continue;
    if (allowOtherHosts && host !== seedHost) {
      const widened = includeDomains!.some(d => domainMatches(host, d));
      if (!widened) continue;
    }
    if (excludeDomains && excludeDomains.some(d => domainMatches(host, d))) continue;

    const normalized = normalize(parsed);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(parsed.toString());
    if (out.length >= maxPages) break;
  }

  return out;
}

function domainMatches(host: string, pattern: string): boolean {
  const p = pattern.toLowerCase().replace(/^\*\./, '');
  const h = host.toLowerCase();
  return h === p || h.endsWith(`.${p}`);
}

function normalize(parsed: URL): string {
  const copy = new URL(parsed.toString());
  copy.hash = '';
  return copy.toString().replace(/\/$/, '');
}

async function fetchPagesInChunks(
  urls: string[],
  router: SmartRouter,
  extractor: Awaited<ReturnType<typeof getExtractProvider>>,
  concurrency: number,
  fetchTimeoutMs: number,
): Promise<FetchedPage[]> {
  const out: FetchedPage[] = [];
  for (let i = 0; i < urls.length; i += concurrency) {
    const chunk = urls.slice(i, i + concurrency);
    const settled = await Promise.allSettled(
      chunk.map(async u => {
        const raw = await withTimeout(
          router.fetch(u, { renderJs: 'auto' }),
          fetchTimeoutMs,
        );
        if (
          !raw ||
          typeof raw.statusCode !== 'number' ||
          raw.statusCode < 200 ||
          raw.statusCode >= 300
        ) {
          throw new Error(`bad status: ${raw?.statusCode ?? 'unknown'}`);
        }
        const ex = await extractor.extract(raw.html, raw.finalUrl, {
          contentType: raw.contentType,
        });
        return {
          url: raw.finalUrl,
          title: ex.title || raw.finalUrl,
          markdown: ex.markdown ?? '',
          text: buildPageText(ex.title, ex.markdown ?? ''),
        } satisfies FetchedPage;
      }),
    );
    for (const r of settled) {
      if (r.status === 'fulfilled') out.push(r.value);
      else log.debug('crawl-rank page fetch failed', { error: String(r.reason) });
    }
  }
  return out;
}

function buildPageText(title: string, markdown: string): string {
  const t = (title ?? '').trim();
  const body = (markdown ?? '').slice(0, SEED_TEXT_CHARS);
  return t ? `${t}\n${body}` : body;
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (!a || !b || a.length === 0 || b.length === 0) return 0;
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function degradedResults(links: string[], maxResults: number): FindSimilarResult[] {
  const limited = links.slice(0, maxResults);
  const n = limited.length;
  return limited.map((url, i) => ({
    url,
    title: url,
    markdown: '',
    relevance_score: n > 0 ? 1 - i / n : 0,
    source: 'search',
    trusted: false, // degraded web links — page-derived, never trusted as instructions
    match_signals: {
      fused_score: n > 0 ? 1 - i / n : 0,
    },
  }));
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    p.then(
      v => {
        clearTimeout(t);
        resolve(v);
      },
      e => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

function emptyOutput(args: {
  error: string;
  embeddingAvailable: boolean;
  elapsed: number;
}): FindSimilarOutput {
  return {
    results: [],
    method: 'fts5',
    cache_hits: 0,
    search_hits: 0,
    embedding_available: args.embeddingAvailable,
    error: args.error,
    total_time_ms: args.elapsed,
  };
}
