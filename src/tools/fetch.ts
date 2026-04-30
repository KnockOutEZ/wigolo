import type { FetchInput, FetchOutput, CachedContent } from '../types.js';
import type { SmartRouter } from '../fetch/router.js';
import { extractContent } from '../extraction/pipeline.js';
import { getCachedContent, cacheContent, isExpired } from '../cache/store.js';
import { extractSection } from '../extraction/markdown.js';
import { detectChange } from '../cache/change-detector.js';
import { getEmbeddingService } from '../embedding/embed.js';
import { truncateSmartly } from '../search/truncate.js';
import { buildEvidenceFromMarkdown } from '../search/evidence.js';
import { createLogger } from '../logger.js';

const log = createLogger('fetch');

const DEFAULT_MAX_TOKENS_OUT = 4000;

async function attachEvidence(
  output: FetchOutput,
  input: FetchInput,
  markdown: string,
): Promise<void> {
  if (!markdown) return;
  const includeFull = input.include_full_markdown ?? false;
  const maxTokensOut = input.max_tokens_out ?? DEFAULT_MAX_TOKENS_OUT;
  const evidence = await buildEvidenceFromMarkdown(
    output.title || output.url,
    output.title,
    output.url,
    markdown,
    { maxTokensOut, maxItems: 1 },
  );
  if (evidence.length > 0) output.evidence = evidence;
  if (!includeFull) {
    output.markdown = '';
  }
}

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

  if (input.max_content_chars !== undefined) {
    markdown = truncateSmartly(markdown, input.max_content_chars);
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
    if (!input.force_refresh) {
      const cached = getCachedContent(input.url);
      if (cached && !isExpired(cached) && (!input.actions || input.actions.length === 0)) {
        log.info('Serving from cache', { url: input.url });
        const out = formatCachedResponse(cached, input);
        const fullMarkdown = out.markdown;
        await attachEvidence(out, input, fullMarkdown);
        return out;
      }
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

    try {
      cacheContent(raw, extraction);
    } catch (err) {
      log.warn('failed to cache fetched content', { url: raw.finalUrl, error: String(err) });
    }

    try {
      const embeddingService = getEmbeddingService();
      if (embeddingService.isAvailable()) {
        embeddingService.embedAsync(raw.finalUrl, extraction.markdown);
      }
    } catch (err) {
      log.debug('embedding hook skipped', { error: String(err) });
    }

    const finalMarkdown = input.max_content_chars !== undefined
      ? truncateSmartly(extraction.markdown, input.max_content_chars)
      : extraction.markdown;

    const out: FetchOutput = {
      url: raw.finalUrl,
      title: extraction.title,
      markdown: finalMarkdown,
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

    await attachEvidence(out, input, finalMarkdown);
    return out;
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
