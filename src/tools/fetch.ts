import type { FetchInput, FetchOutput, CachedContent, StageResult } from '../types.js';
import type { SmartRouter } from '../fetch/router.js';
import { extractContent } from '../extraction/pipeline.js';
import { getCachedContent, cacheContent, isCacheUsable } from '../cache/store.js';
import { getConfig } from '../config.js';
import { extractSection } from '../extraction/markdown.js';
import { detectChange } from '../cache/change-detector.js';
import { getEmbeddingService } from '../embedding/embed.js';
import { truncateSmartly, applyOutputBudget } from '../search/truncate.js';
import { buildEvidenceFromMarkdown } from '../search/evidence.js';
import { resolveMode } from '../util/mode.js';
import { createLogger } from '../logger.js';

const log = createLogger('fetch');

const DEFAULT_MAX_TOKENS_OUT = 4000;
// Fetch is single-URL — users explicitly want the body. Keep a generous cap
// that fits typical MCP tool-result limits (~25k tokens) but prevents huge
// pages (full doc sites) from blowing the cap. Override via max_tokens_out.
const DEFAULT_FETCH_BODY_TOKENS = 16000;

async function attachEvidence(
  output: FetchOutput,
  input: FetchInput,
  markdown: string,
): Promise<void> {
  if (!markdown) return;
  const includeFull = input.include_full_markdown ?? true;
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
  } else if (output.markdown) {
    output.markdown = applyOutputBudget(output.markdown, {
      maxTokensOut: input.max_tokens_out ?? DEFAULT_FETCH_BODY_TOKENS,
      maxChars: input.max_chars,
    });
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
    cached_at: cached.fetchedAt,
  };
}

export async function handleFetch(
  input: FetchInput,
  router: SmartRouter,
): Promise<StageResult<FetchOutput>> {
  const mode = resolveMode(input.mode);
  try {
    if (!input.force_refresh) {
      const cached = getCachedContent(input.url);
      if (cached && (!input.actions || input.actions.length === 0)) {
        const staleMaxSeconds = mode === 'cache' ? getConfig().fastStaleMaxHours * 3600 : 0;
        const { usable, stale } = isCacheUsable(cached, { staleMaxSeconds });
        if (usable) {
          log.info('Serving from cache', { url: input.url, stale });
          const out = formatCachedResponse(cached, input);
          if (stale) out.stale = true;
          const fullMarkdown = out.markdown;
          await attachEvidence(out, input, fullMarkdown);
          return { ok: true, data: out };
        }
      }
    }

    if (mode === 'cache') {
      return {
        ok: false,
        error: 'cache_miss',
        error_reason: `URL not in cache: ${input.url}`,
        stage: 'fetch',
        hint: 'Use mode:default to fetch live, or run search/crawl first to populate cache',
      };
    }

    const raw = await router.fetch(input.url, {
      renderJs: input.render_js ?? 'auto',
      useAuth: input.use_auth ?? false,
      headers: input.headers,
      screenshot: input.screenshot,
      actions: input.actions,
      mode,
    });

    // T11: stealth mode can return a StageError (e.g., playwright_not_installed,
    // playwright_fetch_failed). Surface it directly.
    if ('error' in raw && typeof (raw as { error?: unknown }).error === 'string') {
      const stageErr = raw as unknown as { error: string; error_reason?: string; stage?: string; hint?: string };
      return {
        ok: false,
        error: stageErr.error,
        error_reason: stageErr.error_reason ?? stageErr.error,
        stage: stageErr.stage ?? 'fetch',
        ...(stageErr.hint ? { hint: stageErr.hint } : {}),
      };
    }

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
      ...(raw.jsRequired ? { js_required: true } : {}),
      ...(changeResult?.changed ? {
        changed: true,
        previous_hash: changeResult.previousHash,
        diff_summary: changeResult.diffSummary,
      } : {}),
    };

    await attachEvidence(out, input, finalMarkdown);
    return { ok: true, data: out };
  } catch (err) {
    log.error('Fetch failed', { url: input.url, error: String(err) });
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: 'fetch_failed',
      error_reason: msg,
      stage: 'fetch',
    };
  }
}
