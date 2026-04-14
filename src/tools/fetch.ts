import type { FetchInput, FetchOutput, CachedContent } from '../types.js';
import type { SmartRouter } from '../fetch/router.js';
import { extractContent } from '../extraction/pipeline.js';
import { getCachedContent, cacheContent, isExpired } from '../cache/store.js';
import { extractSection } from '../extraction/markdown.js';
import { detectChange } from '../cache/change-detector.js';
import { createLogger } from '../logger.js';

const log = createLogger('fetch');

function formatCachedResponse(cached: CachedContent, input: FetchInput): FetchOutput {
  let markdown = cached.markdown;
  let sectionMatched: boolean | undefined;

  if (input.section) {
    const result = extractSection(markdown, input.section, input.section_index);
    markdown = result.content;
    sectionMatched = result.matched;
  }

  if (input.max_chars && markdown.length > input.max_chars) {
    markdown = markdown.slice(0, input.max_chars);
  }

  return {
    url: cached.url,
    title: cached.title,
    markdown,
    metadata: {
      ...JSON.parse(cached.metadata || '{}'),
      ...(sectionMatched !== undefined ? { section_matched: sectionMatched } : {}),
    },
    links: JSON.parse(cached.links || '[]'),
    images: JSON.parse(cached.images || '[]'),
    cached: true,
  };
}

export async function handleFetch(
  input: FetchInput,
  router: SmartRouter,
): Promise<FetchOutput> {
  try {
    const cached = getCachedContent(input.url);
    if (cached && !isExpired(cached) && (!input.actions || input.actions.length === 0)) {
      log.info('Serving from cache', { url: input.url });
      return formatCachedResponse(cached, input);
    }

    const raw = await router.fetch(input.url, {
      renderJs: input.render_js ?? 'auto',
      useAuth: input.use_auth ?? false,
      headers: input.headers,
      screenshot: input.screenshot,
      actions: input.actions,
    });

    const extraction = await extractContent(raw.html, raw.finalUrl, {
      maxChars: input.max_chars,
      section: input.section,
      sectionIndex: input.section_index,
      contentType: raw.contentType,
      pdfBuffer: raw.rawBuffer,
    });

    let changeResult: { changed: boolean; previousHash?: string; diffSummary?: string } | undefined;
    try {
      changeResult = detectChange(raw.finalUrl, extraction.markdown);
    } catch (err) {
      log.warn('change detection failed', { url: raw.finalUrl, error: String(err) });
    }

    cacheContent(raw, extraction);

    return {
      url: raw.finalUrl,
      title: extraction.title,
      markdown: extraction.markdown,
      metadata: extraction.metadata,
      links: extraction.links,
      images: extraction.images,
      screenshot: raw.screenshot,
      cached: false,
      action_results: raw.actionResults,
      ...(changeResult?.changed ? {
        changed: true,
        previous_hash: changeResult.previousHash,
        diff_summary: changeResult.diffSummary,
      } : {}),
    };
  } catch (err) {
    log.error('Fetch failed', { url: input.url, error: String(err) });
    return {
      url: input.url,
      title: '',
      markdown: '',
      metadata: {},
      links: [],
      images: [],
      cached: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
