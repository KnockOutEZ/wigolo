import type {
  CrawlInput,
  CrawlOutput,
  MapOutput,
} from '../types.js';
import type { SmartRouter } from '../fetch/router.js';
import { Crawler } from '../crawl/crawler.js';
import { deduplicatePages } from '../crawl/dedup.js';
import { mapUrls } from '../crawl/mapper.js';
import { handleFetch } from './fetch.js';
import {
  buildEvidenceFromMarkdown,
  applyAggregateMarkdownBudget,
} from '../search/evidence.js';
import { countTokens } from '../search/tokens.js';
import { createLogger } from '../logger.js';
import { guardFetchUrl } from '../watch/ssrf.js';
import { getConfig } from '../config.js';

const log = createLogger('crawl');

const DEFAULT_MAX_TOTAL_CHARS = 100000;
const DEFAULT_MAX_TOKENS_OUT = 4000;
// Crawl is inherently multi-page, so the default markdown budget scales with
// page count (a flat 4000-token aggregate starves later pages). max_total_chars
// still bounds total bytes; MAX_TOKENS_OUT_CEILING caps the scaled default so a
// huge crawl can't request an unbounded token budget.
const PER_PAGE_TOKENS = 2000;
const MAX_TOKENS_OUT_CEILING = 60000;
// Per-page floor so a page with real markdown is never emptied while an earlier
// page kept content, even when the shared budget is exhausted.
const MIN_TOKENS_PER_PAGE = 256;

export async function handleCrawl(
  input: CrawlInput,
  router: SmartRouter,
): Promise<CrawlOutput | (MapOutput & { crawled: number })> {
  const _start = Date.now();
  try {
    // SSRF guard on the seed URL — same policy as `fetch`. The downstream
    // per-page fetches inherit protection because they route through
    // handleFetch which already guards.
    const seedGuard = guardFetchUrl(input.url, 'url', {
      allowPrivate: getConfig().fetchAllowPrivate,
    });
    if (!seedGuard.ok) {
      return {
        pages: [],
        total_found: 0,
        crawled: 0,
        response_time_ms: Date.now() - _start,
        error: seedGuard.reason,
      };
    }

    // Map strategy: lightweight URL-only discovery, skip full crawl pipeline
    if (input.strategy === 'map') {
      return handleMapStrategy(input, router);
    }

    // Crawler needs full markdown internally for dedup; opt in explicitly so
    // handleFetch's default strip does not steal page bodies mid-crawl.
    const fetchFn = async (url: string) => {
      const r = await handleFetch({ url, use_auth: input.use_auth, include_full_markdown: true }, router);
      if (!r.ok) {
        return {
          url,
          title: '',
          markdown: '',
          metadata: {},
          links: [],
          images: [],
          cached: false,
          error: r.error_reason,
        };
      }
      return r.data;
    };

    const rawFetchFn = async (url: string) =>
      router.fetch(url, { renderJs: 'never' });

    const crawler = new Crawler(fetchFn, rawFetchFn);
    const result = await crawler.crawl(input);

    // Deduplicate cross-page content (pass domain for SQLite boilerplate caching)
    const domain = new URL(input.url).hostname;
    const dedupedPages = deduplicatePages(
      result.pages.map((p) => ({ url: p.url, markdown: p.markdown })),
      domain,
    );

    // Apply deduped markdown back to pages
    const pages = result.pages.map((page, i) => ({
      ...page,
      markdown: dedupedPages[i]?.markdown ?? page.markdown,
    }));

    // Enforce max_total_chars budget
    const maxTotalChars = input.max_total_chars ?? DEFAULT_MAX_TOTAL_CHARS;
    const budgetedPages = [];
    let charCount = 0;

    for (const page of pages) {
      if (charCount + page.markdown.length > maxTotalChars && budgetedPages.length > 0) {
        break;
      }
      budgetedPages.push(page);
      charCount += page.markdown.length;
    }

    const droppedOverBudget = result.crawled - budgetedPages.length;
    log.info('Crawl complete', {
      url: input.url,
      crawled: result.crawled,
      returned: budgetedPages.length,
      totalChars: charCount,
      droppedOverBudget,
    });

    const out: CrawlOutput = {
      pages: budgetedPages,
      total_found: result.total_found,
      crawled: budgetedPages.length,
      ...(droppedOverBudget > 0 ? { dropped_over_budget: droppedOverBudget } : {}),
      ...(result.links ? { links: result.links } : {}),
    };

    await attachEvidence(out, input);
    out.response_time_ms = Date.now() - _start;
    return out;
  } catch (err) {
    log.error('Crawl failed', { url: input.url, error: String(err) });
    return {
      pages: [],
      total_found: 0,
      crawled: 0,
      response_time_ms: Date.now() - _start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function buildPageExcerpt(markdown: string, maxChars = 600): string {
  if (!markdown) return '';
  const paragraphs = markdown.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);
  let out = '';
  for (const p of paragraphs) {
    if (out.length + p.length + 2 > maxChars) {
      const remaining = maxChars - out.length;
      if (remaining > 80) out += (out ? '\n\n' : '') + p.slice(0, remaining) + '…';
      break;
    }
    out += (out ? '\n\n' : '') + p;
  }
  return out;
}

async function attachEvidence(out: CrawlOutput, input: CrawlInput): Promise<void> {
  if (out.pages.length === 0) return;
  // The crawl tool previously stripped `markdown` to ''
  // on every page when `include_full_markdown` was unset, even though the
  // crawler had already run the full extraction pipeline per page. That
  // forced callers to opt-in just to see the bodies the crawl had already
  // produced. Flip the default so the extracted markdown survives —
  // `max_tokens_out` / `max_total_chars` still bound the response — and
  // honour an explicit `include_full_markdown: false` for callers that
  // really only want the per-page evidence + excerpt envelope.
  const includeFull = input.include_full_markdown ?? true;
  // Scale the default aggregate budget with page count so later pages are not
  // starved. An explicit max_tokens_out is honored as-is; max_total_chars still
  // bounds total bytes.
  const maxTokensOut = input.max_tokens_out ?? Math.min(
    MAX_TOKENS_OUT_CEILING,
    Math.max(DEFAULT_MAX_TOKENS_OUT, PER_PAGE_TOKENS * out.pages.length),
  );

  let used = 0;
  for (const page of out.pages) {
    if (!page.markdown) continue;
    const remaining = maxTokensOut - used;
    if (remaining <= 0) break;
    const evs = await buildEvidenceFromMarkdown(
      page.title || page.url,
      page.title,
      page.url,
      page.markdown,
      { maxItems: 1, maxTokensOut: remaining },
    );
    if (evs.length > 0) {
      page.evidence = evs;
      for (const ev of evs) used += countTokens(ev.excerpt);
    }
  }

  if (!includeFull) {
    // Explicit opt-out: surface a short excerpt per page so the response is
    // still useful when no evidence could be built (no query to highlight),
    // then drop the full body to keep the envelope tight.
    for (const page of out.pages) {
      if (!page.evidence || page.evidence.length === 0) {
        const excerpt = buildPageExcerpt(page.markdown);
        if (excerpt) page.excerpt = excerpt;
      }
      page.markdown = '';
    }
  } else {
    applyAggregateMarkdownBudget(
      out.pages,
      (p) => p.markdown ?? '',
      (p, body) => { p.markdown = body; },
      { maxTokensOut, minTokensPerItem: MIN_TOKENS_PER_PAGE },
    );
  }
}

async function handleMapStrategy(
  input: CrawlInput,
  router: SmartRouter,
): Promise<MapOutput & { crawled: number }> {
  const httpFetchFn = async (url: string) => {
    const raw = await router.fetch(url, { renderJs: 'never' });
    return { html: raw.html, finalUrl: raw.finalUrl, statusCode: raw.statusCode };
  };

  try {
    const mapResult = await mapUrls(
      {
        url: input.url,
        max_depth: input.max_depth,
        max_pages: input.max_pages,
        include_patterns: input.include_patterns,
        exclude_patterns: input.exclude_patterns,
      },
      httpFetchFn,
    );

    log.info('Map complete', {
      url: input.url,
      total_found: mapResult.total_found,
      sitemap_found: mapResult.sitemap_found,
    });

    return {
      urls: mapResult.urls,
      total_found: mapResult.total_found,
      sitemap_found: mapResult.sitemap_found,
      crawled: 0,
      ...(mapResult.error ? { error: mapResult.error } : {}),
    };
  } catch (err) {
    log.error('Map strategy failed', { url: input.url, error: String(err) });
    return {
      urls: [],
      total_found: 0,
      sitemap_found: false,
      crawled: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
