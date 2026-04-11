import type { FetchInput, FetchOutput, CachedContent } from '../types.js';
import type { SmartRouter } from '../fetch/router.js';
import { extractContent } from '../extraction/pipeline.js';
import { getCachedContent, cacheContent, isExpired } from '../cache/store.js';
import { extractSection } from '../extraction/markdown.js';
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
    if (cached && !isExpired(cached)) {
      log.info('Serving from cache', { url: input.url });
      return formatCachedResponse(cached, input);
    }

    const raw = await router.fetch(input.url, {
      renderJs: input.render_js ?? 'auto',
      useAuth: input.use_auth ?? false,
      headers: input.headers,
    });

    const extraction = await extractContent(raw.html, raw.finalUrl, {
      maxChars: input.max_chars,
      section: input.section,
      sectionIndex: input.section_index,
      contentType: raw.contentType,
    });

    cacheContent(raw, extraction);

    return {
      url: raw.finalUrl,
      title: extraction.title,
      markdown: extraction.markdown,
      metadata: extraction.metadata,
      links: extraction.links,
      images: extraction.images,
      cached: false,
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
