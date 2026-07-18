import { createHash } from 'node:crypto';
import type { FetchInput, FetchOutput, CachedContent, StageResult } from '../types.js';
import { describeFetchError } from '../fetch/error-describe.js';
import type { SmartRouter } from '../fetch/router.js';
import { getExtractProvider } from '../providers/extract-provider.js';
import { getCachedContent, cacheContent, isCacheUsable } from '../cache/store.js';
import { getConfig } from '../config.js';
import { extractSection } from '../extraction/markdown.js';
import { detectChange } from '../cache/change-detector.js';
import { getEmbeddingService } from '../embedding/embed.js';
import { truncateSmartly, applyOutputBudget } from '../search/truncate.js';
import { buildEvidenceFromMarkdown } from '../search/evidence.js';
import { resolveMode } from '../util/mode.js';
import { createLogger } from '../logger.js';
import { guardFetchUrl } from '../watch/ssrf.js';

const log = createLogger('fetch');

const DEFAULT_MAX_TOKENS_OUT = 4000;
// Fetch is single-URL — users explicitly want the body. Keep a generous cap
// that fits typical MCP tool-result limits (~25k tokens) but prevents huge
// pages (full doc sites) from blowing the cap. Override via max_tokens_out.
const DEFAULT_FETCH_BODY_TOKENS = 16000;
// When the caller asks for a tight markdown budget, also clip the
// auxiliary arrays — large doc pages emit thousands of links/images that
// otherwise blow the user-requested response size.
const AUX_FIELD_CAP_WHEN_CHARS_BOUNDED = 50;
const AUX_FIELD_CAP_WHEN_TIGHT = 20;

/**
 * Precise URL validation for the fetch tool. Callers can pass a localhost
 * URL with an out-of-range port (e.g. localhost:99999) and get a vague
 * TypeError / cache-miss surface instead of a clear "invalid port"
 * message. This validator
 * runs BEFORE any cache/router code, identifies the failure shape, and
 * returns a structured envelope the handler turns into a stage error.
 *
 * Localhost URLs with a VALID port are accepted (the docs promise local
 * dev servers work).
 */
function validateFetchUrl(raw: unknown): { ok: true } | { ok: false; reason: string; hint?: string } {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { ok: false, reason: 'url is required and must be a non-empty string' };
  }
  // Detect localhost-with-bad-port BEFORE the URL constructor, since the
  // constructor's TypeError message reads "Invalid URL" without saying
  // what's actually wrong. Scope to the loopback hostnames so a real bad
  // URL still gets the generic message.
  const portMatch = raw.match(/^https?:\/\/(localhost|127\.0\.0\.1|\[?::1\]?)(?::([^\/?#]*))?/i);
  if (portMatch && portMatch[2] !== undefined) {
    const portStr = portMatch[2];
    const portNum = Number(portStr);
    if (!/^\d+$/.test(portStr) || !Number.isFinite(portNum) || portNum < 1 || portNum > 65535) {
      return {
        ok: false,
        reason: `invalid port "${portStr}" — localhost URLs require a valid port in 1-65535`,
        hint: 'Use a port in 1-65535 (e.g. localhost:3000). Localhost itself is allowed for fetch/crawl; only the port is rejected.',
      };
    }
  }
  if (!URL.canParse(raw)) {
    return {
      ok: false,
      reason: `url is not a valid absolute URL: ${JSON.stringify(raw)}`,
      hint: 'Pass a fully qualified http(s) URL (e.g. "https://example.com/path").',
    };
  }
  return { ok: true };
}

function capAuxFields(out: FetchOutput, maxContentChars?: number): void {
  if (maxContentChars === undefined) return;
  const cap = maxContentChars <= 4000 ? AUX_FIELD_CAP_WHEN_TIGHT : AUX_FIELD_CAP_WHEN_CHARS_BOUNDED;
  if (out.links && out.links.length > cap) out.links = out.links.slice(0, cap);
  if (out.images && out.images.length > cap) out.images = out.images.slice(0, cap);
}

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

  // section_matched=false must NOT serve the full body —
  // returning the whole page when the caller explicitly asked for a section
  // is a classic "silent-failure" mode. Empty the body and leave
  // section_matched=false visible so the caller can branch.
  if (sectionMatched === false) {
    markdown = '';
  }

  const out: FetchOutput = {
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
    fetch_method: 'cache',
    // Full-body fingerprint from the cached row (sha256 of the full
    // markdown at cache-write time). Matches the fresh-fetch content_hash so
    // change-detection consumers get a stable value on cache hits too. Guard
    // against a legacy row with an empty hash.
    ...(cached.contentHash ? { content_hash: cached.contentHash } : {}),
    // Surface the recorded HTTP status when available. Null
    // means the row predates the column; we simply omit the field.
    ...(typeof cached.httpStatus === 'number' ? { http_status: cached.httpStatus } : {}),
  };
  capAuxFields(out, input.max_content_chars);
  return out;
}

export async function handleFetch(
  input: FetchInput,
  router: SmartRouter,
): Promise<StageResult<FetchOutput>> {
  const mode = resolveMode(input.mode);
  const _fetchStart = Date.now();
  const stampTime = (out: FetchOutput): FetchOutput => {
    out.response_time_ms = Date.now() - _fetchStart;
    return out;
  };

  // Pre-validate the URL so an invalid-port error reads as
  // "invalid port" rather than the downstream "URL not in cache" / generic
  // TypeError surface. Localhost URLs (localhost:3000) are explicitly
  // accepted — the docs promise they work — provided the port is parseable.
  const urlValidation = validateFetchUrl(input.url);
  if (!urlValidation.ok) {
    return {
      ok: false,
      error: 'invalid_url',
      error_reason: urlValidation.reason,
      stage: 'fetch',
      hint: urlValidation.hint,
    };
  }

  // SSRF guard — same gate the `watch` tool uses, but with loopback exempted
  // for fetch/crawl. Blocks private LAN ranges, link-local (incl. cloud
  // metadata endpoints like 169.254.169.254), and metadata hostnames.
  // Set WIGOLO_FETCH_ALLOW_PRIVATE=1 to opt into the old permissive
  // behaviour for home LAN devices.
  const ssrf = guardFetchUrl(input.url!, 'url', {
    allowPrivate: getConfig().fetchAllowPrivate,
  });
  if (!ssrf.ok) {
    return {
      ok: false,
      error: 'invalid_url',
      error_reason: ssrf.reason,
      stage: 'fetch',
      hint: ssrf.hint,
    };
  }

  try {
    // Stealth mode is the retry-past-a-block escape hatch: it must always
    // fetch fresh, never replay a stale cached row (which may carry a
    // previously-cached anti-bot 403 body). Treat it like force_refresh.
    if (!input.force_refresh && mode !== 'stealth') {
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
          return { ok: true, data: stampTime(out) };
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

    // stealth mode can return a StageError (e.g., playwright_not_installed,
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

    // Plain-text endpoints (raw.githubusercontent.com, gist raw, /robots.txt,
    // etc.) return HTTP 4xx/5xx with a short error body. We must not pass that
    // body to the extractor as if it were article content — surface the HTTP
    // failure so callers can react. HTML pages with 4xx status often still
    // render a useful error landing page (404 docs), so only escalate plain
    // text/markdown/JSON status codes here.
    const ct = raw.contentType?.toLowerCase() ?? '';
    const isMachineBody = !ct || /^(text\/plain|text\/markdown|application\/(json|xml|x-yaml))/i.test(ct);
    if (raw.statusCode >= 400 && isMachineBody) {
      const snippet = (raw.html ?? '').slice(0, 200).trim();
      return {
        ok: false,
        error: `http_${raw.statusCode}`,
        error_reason: `Upstream returned HTTP ${raw.statusCode}${snippet ? `: ${snippet}` : ''}`,
        stage: 'fetch',
        hint: raw.statusCode === 404
          ? 'Check the URL — file/branch may have been removed or renamed'
          : 'Retry later or check upstream status',
      };
    }

    const extractor = await getExtractProvider();
    const extraction = await extractor.extract(raw.html, raw.finalUrl, {
      maxChars: input.max_chars,
      section: input.section,
      sectionIndex: input.section_index,
      contentType: raw.contentType,
      pdfBuffer: raw.rawBuffer,
    });

    let changeResult: { changed: boolean; previousHash?: string; diffSummary?: string } | undefined;
    try {
      // Pass the upstream status code so a 200→404 transition
      // (or vice-versa) is reported as changed even when the body hash
      // happens to match — the previous implementation was status-blind.
      changeResult = detectChange(raw.finalUrl, extraction.markdown, raw.statusCode);
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

    // When the caller asked for a section, detect whether
    // the extractor's pipeline actually matched a heading. The v1 pipeline
    // currently slices to the section internally but does not signal a
    // miss — we re-run extractSection on the cleaned markdown to determine
    // match success at the tool layer so we can guard the body the same way
    // the cached path does. This double-call is cheap (linear in markdown
    // length) and only fires when `input.section` is set. The probe is
    // wrapped in a defensive try-catch so a mocked / replaced extractSection
    // (test environment) never breaks the production code path.
    let freshSectionMatched: boolean | undefined;
    if (input.section) {
      try {
        const probe = extractSection(extraction.markdown, input.section, input.section_index);
        if (probe && typeof probe.matched === 'boolean') {
          freshSectionMatched = probe.matched;
        }
      } catch (err) {
        log.debug('section match probe failed', { url: raw.finalUrl, error: String(err) });
      }
    }

    let finalMarkdown = input.max_content_chars !== undefined
      ? truncateSmartly(extraction.markdown, input.max_content_chars)
      : extraction.markdown;

    if (freshSectionMatched === false) {
      finalMarkdown = '';
    }

    const out: FetchOutput = {
      url: raw.finalUrl,
      title: extraction.title,
      markdown: finalMarkdown,
      metadata: {
        ...extraction.metadata,
        ...(freshSectionMatched !== undefined ? { section_matched: freshSectionMatched } : {}),
      },
      links: extraction.links,
      images: extraction.images,
      screenshot: raw.screenshot,
      cached: false,
      action_results: raw.actionResults,
      // Propagate the router-chosen tier name onto the public response so
      // callers can audit which path served the bytes (P2 visibility).
      fetch_method: raw.method,
      // Always surface the upstream status code on fresh
      // fetches so callers / cache consumers can distinguish 200 / 404 /
      // 5xx pages that may extract to a usable HTML body.
      ...(typeof raw.statusCode === 'number' ? { http_status: raw.statusCode } : {}),
      ...(raw.jsRequired ? { js_required: true } : {}),
      // Stable fingerprint of the FULL extracted body — computed on
      // extraction.markdown BEFORE the presentation budget clips the returned
      // `markdown`. Change-detection consumers (watch scheduler, diff) key off
      // this so a change past the truncation point is never silently missed.
      content_hash: createHash('sha256').update(extraction.markdown).digest('hex'),
      ...(changeResult?.changed ? {
        changed: true,
        previous_hash: changeResult.previousHash,
        diff_summary: changeResult.diffSummary,
      } : {}),
      // Per-site structured JSON (e.g. Reddit `comments[]`, YouTube
      // `caption_tracks[]`, Amazon `asin`/`price`). Populated by the routed
      // extractor for sites with a site-specific extractor; absent otherwise.
      // Surfacing at top level (rather than nesting under `extra`) matches
      // the existing house style for `evidence` / `screenshot`.
      ...(extraction.site_data ? { site_data: extraction.site_data } : {}),
      // Partial-success marker. When a Reddit / Amazon site
      // extractor detected an anti-bot or page-not-found body, the routed
      // extractor sets `site_data_blocked` and we surface it on the envelope
      // as `fetch_failed` so callers branch honestly. site_data is
      // intentionally absent in that case.
      ...(extraction.site_data_blocked
        ? { fetch_failed: extraction.site_data_blocked }
        : {}),
    };

    capAuxFields(out, input.max_content_chars);
    await attachEvidence(out, input, finalMarkdown);
    return { ok: true, data: stampTime(out) };
  } catch (err) {
    log.error('Fetch failed', { url: input.url, error: String(err) });
    const described = describeFetchError(err);
    return {
      ok: false,
      error: 'fetch_failed',
      error_reason: described.reason,
      stage: 'fetch',
      ...(described.hint ? { hint: described.hint } : {}),
    };
  }
}
