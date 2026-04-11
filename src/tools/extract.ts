import type { ExtractInput, ExtractOutput } from '../types.js';
import type { SmartRouter } from '../fetch/router.js';
import { extractMetadata, extractSelector, extractTables } from '../extraction/extract.js';
import { getCachedContent, isExpired } from '../cache/store.js';
import { createLogger } from '../logger.js';

const log = createLogger('extract');

async function resolveHtml(
  input: ExtractInput,
  router: SmartRouter,
): Promise<{ html: string; sourceUrl?: string }> {
  if (input.url) {
    const cached = getCachedContent(input.url);
    if (cached && !isExpired(cached)) {
      log.info('Using cached HTML', { url: input.url });
      return { html: cached.rawHtml, sourceUrl: cached.url };
    }

    const raw = await router.fetch(input.url, {
      renderJs: 'auto',
      useAuth: false,
    });
    return { html: raw.html, sourceUrl: raw.finalUrl };
  }

  return { html: input.html! };
}

export async function handleExtract(
  input: ExtractInput,
  router: SmartRouter,
): Promise<ExtractOutput> {
  const mode = input.mode ?? 'metadata';

  if (!input.url && !input.html) {
    return { data: {}, mode, error: 'Either url or html must be provided' };
  }

  if (mode === 'selector' && !input.css_selector) {
    return { data: '', mode, error: 'css_selector is required when mode is "selector"' };
  }

  try {
    const { html, sourceUrl } = await resolveHtml(input, router);

    let data: ExtractOutput['data'];

    switch (mode) {
      case 'selector':
        data = extractSelector(html, input.css_selector!, input.multiple ?? false);
        break;
      case 'tables':
        data = extractTables(html);
        break;
      case 'metadata':
      default:
        data = extractMetadata(html);
        break;
    }

    return { data, source_url: sourceUrl, mode };
  } catch (err) {
    log.error('Extract failed', { url: input.url, error: String(err) });
    return {
      data: mode === 'selector' ? '' : mode === 'tables' ? [] : {},
      source_url: input.url,
      mode,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
