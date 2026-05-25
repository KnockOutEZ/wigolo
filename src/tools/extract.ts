import type { ExtractInput, ExtractOutput, StageResult } from '../types.js';
import type { SmartRouter } from '../fetch/router.js';
import { extractMetadata, extractSelector, extractTables } from '../extraction/extract.js';
import {
  extractWithSchema,
  extractWithSchemaDetailedAsync,
} from '../extraction/schema.js';
import { extractJsonLd } from '../extraction/jsonld.js';
import { extractStructured } from '../extraction/structured.js';
import { getCachedContent, isExpired } from '../cache/store.js';
import { fetchWithPlaywright } from '../fetch/playwright-tier.js';
import { countTokens, truncateByTokens } from '../search/tokens.js';
import { createLogger } from '../logger.js';
import {
  isNamedSchemaType,
  extractNamedSchema,
  NAMED_SCHEMAS,
} from '../extraction/v1/schemas/index.js';
import { isLocalLlmEnabled, extractWithLocalLlm } from '../extraction/v1/local-llm.js';
import { extractBrandAsync } from '../extraction/brand.js';

const log = createLogger('extract');

// Trim a structured extraction payload to fit within `maxTokens`.
//   - arrays: keep prefix items until budget exhausted, then stop.
//   - objects with array fields (StructuredData): trim each array in
//     descending order of token weight until total fits.
//   - primitives: returned untouched (already under budget by construction).
// Returns a shallow copy; never mutates the input.
function clampExtractData(
  data: ExtractOutput['data'],
  maxTokens: number,
): ExtractOutput['data'] {
  if (data === null || data === undefined) return data;
  const total = countTokens(JSON.stringify(data));
  if (total <= maxTokens) return data;

  if (Array.isArray(data)) {
    const out: unknown[] = [];
    let used = 2; // [] brackets
    for (const item of data) {
      const t = countTokens(JSON.stringify(item)) + 1; // comma
      if (used + t > maxTokens) break;
      out.push(item);
      used += t;
    }
    return out as ExtractOutput['data'];
  }

  if (typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    // First, copy small primitive fields (cheap, almost always retained).
    // Stash oversize strings + arrays for proportional truncation in pass 2 so
    // a single huge `body`/`markdown` field never disappears entirely when the
    // caller sets a tight max_tokens_out.
    const arrayKeys: string[] = [];
    const oversizeStringKeys: string[] = [];
    let used = 2; // {} braces
    for (const [k, v] of Object.entries(obj)) {
      if (Array.isArray(v)) {
        arrayKeys.push(k);
        out[k] = [];
        continue;
      }
      const t = countTokens(JSON.stringify({ [k]: v })) - 1; // strip outer braces
      if (used + t <= maxTokens) {
        out[k] = v;
        used += t;
        continue;
      }
      if (typeof v === 'string' && v.length > 0) {
        oversizeStringKeys.push(k);
        out[k] = ''; // placeholder, filled in pass 2
        used += countTokens(JSON.stringify({ [k]: '' })) - 1;
      }
    }
    // Pass 2: distribute remaining budget across oversize string fields
    // (truncate to fit) before filling array fields.
    if (oversizeStringKeys.length > 0) {
      const perField = Math.max(64, Math.floor((maxTokens - used) / oversizeStringKeys.length));
      for (const k of oversizeStringKeys) {
        const original = obj[k] as string;
        const truncated = truncateByTokens(original, perField);
        out[k] = truncated.length < original.length ? `${truncated.trimEnd()}…` : truncated;
        used += countTokens(JSON.stringify({ [k]: out[k] })) - 1;
        // Reclaim placeholder space accounted earlier.
        used -= countTokens(JSON.stringify({ [k]: '' })) - 1;
      }
    }
    // Then fill array fields proportionally, biggest-first.
    arrayKeys.sort((a, b) =>
      countTokens(JSON.stringify(obj[b])) - countTokens(JSON.stringify(obj[a])),
    );
    for (const k of arrayKeys) {
      const arr = obj[k] as unknown[];
      const kept: unknown[] = [];
      for (const item of arr) {
        const t = countTokens(JSON.stringify(item)) + 1;
        if (used + t > maxTokens) break;
        kept.push(item);
        used += t;
      }
      out[k] = kept;
    }
    return out as ExtractOutput['data'];
  }

  return data;
}

function buildSuccessOutput(
  data: ExtractOutput['data'],
  sourceUrl: string | undefined,
  mode: ExtractOutput['mode'],
  maxTokens: number | undefined,
  warnings?: string[],
  startMs?: number,
): StageResult<ExtractOutput> {
  const finalData = maxTokens !== undefined ? clampExtractData(data, maxTokens) : data;
  const out: ExtractOutput = { data: finalData, source_url: sourceUrl, mode };
  if (warnings && warnings.length > 0) out.warnings = warnings;
  if (typeof startMs === 'number') out.response_time_ms = Date.now() - startMs;
  return { ok: true, data: out };
}

async function resolveHtml(
  input: ExtractInput,
  router: SmartRouter,
): Promise<{ html: string; sourceUrl?: string }> {
  if (input.execution_mode === 'stealth' && input.url) {
    const pw = await fetchWithPlaywright(input.url);
    return { html: pw.html, sourceUrl: input.url };
  }

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
): Promise<StageResult<ExtractOutput>> {
  const mode = input.mode ?? 'metadata';
  const _start = Date.now();

  if (!input.url && !input.html) {
    return {
      ok: false,
      error: 'invalid_input',
      error_reason: 'Either url or html must be provided',
      stage: 'extract',
    };
  }

  if (input.named_schema && input.schema) {
    return {
      ok: false,
      error: 'invalid_input',
      error_reason: 'schema and named_schema are mutually exclusive',
      stage: 'extract',
    };
  }

  if (input.named_schema && !isNamedSchemaType(input.named_schema)) {
    return {
      ok: false,
      error: 'invalid_input',
      error_reason: `Unknown named_schema. Valid: ${NAMED_SCHEMAS.join(', ')}`,
      stage: 'extract',
    };
  }

  if (mode === 'selector' && !input.css_selector) {
    return {
      ok: false,
      error: 'invalid_input',
      error_reason: 'css_selector is required when mode is "selector"',
      stage: 'extract',
    };
  }

  if (mode === 'schema' && !input.named_schema && (!input.schema || !input.schema.properties)) {
    return {
      ok: false,
      error: 'invalid_input',
      error_reason: 'schema is required when mode is "schema" and must have properties',
      stage: 'extract',
    };
  }

  try {
    const { html, sourceUrl } = await resolveHtml(input, router);

    if (input.named_schema) {
      const namedData = await extractNamedSchema(input.named_schema, html, sourceUrl ?? input.url ?? '');
      if (namedData === null) {
        return {
          ok: true,
          data: {
            data: {},
            source_url: sourceUrl,
            mode: 'schema',
            error: `No ${input.named_schema} data found on page`,
          },
        };
      }
      return buildSuccessOutput(
        namedData as unknown as Record<string, unknown>,
        sourceUrl,
        'schema',
        input.max_tokens_out,
        undefined,
        _start,
      );
    }

    if (mode === 'schema' && input.schema && isLocalLlmEnabled()) {
      const llmData = await extractWithLocalLlm({
        schema: input.schema as unknown as Record<string, unknown>,
        html,
        url: sourceUrl ?? input.url ?? '',
      });
      return buildSuccessOutput(
        (llmData ?? {}) as Record<string, unknown>,
        sourceUrl,
        'schema',
        input.max_tokens_out,
        undefined,
        _start,
      );
    }

    let data: ExtractOutput['data'];

    switch (mode) {
      case 'selector':
        data = extractSelector(html, input.css_selector!, input.multiple ?? false);
        break;
      case 'tables':
        data = extractTables(html);
        break;
      case 'structured':
        data = extractStructured(html);
        break;
      case 'brand': {
        // B2a + B2b: DOM/meta sources (JSON-LD, OG, favicon, CSS vars,
        // heuristic DOM) plus image-based palette extraction when CSS
        // vars don't surface ≥2 brand colors. The async variant fetches
        // the logo / og:image via a small hook and runs k-means. Pass
        // the resolved source URL as the base so relative logo/favicon
        // hrefs resolve correctly; falls back to the user-supplied url
        // when resolveHtml didn't surface a final URL (raw-html path).
        data = (await extractBrandAsync(html, {
          baseUrl: sourceUrl ?? input.url,
        })) as Record<string, unknown>;
        break;
      }
      case 'schema': {
        const schema = input.schema!;
        if (Array.isArray(schema.required) && schema.required.length > 0) {
          const detailed = await extractWithSchemaDetailedAsync(html, schema);
          data = detailed.values;
          if (detailed.warnings.length > 0) {
            return buildSuccessOutput(data, sourceUrl, mode, input.max_tokens_out, detailed.warnings, _start);
          }
        } else {
          data = extractWithSchema(html, schema);
        }
        break;
      }
      case 'metadata':
      default: {
        const meta = extractMetadata(html);
        const jsonld = extractJsonLd(html);
        if (jsonld.length > 0) {
          meta.jsonld = jsonld;
        }
        data = meta;
        break;
      }
    }

    if (mode === 'tables' && Array.isArray(data) && data.length === 0) {
      const hint =
        input.execution_mode === 'stealth'
          ? 'no_tables_detected — page genuinely contains no tables'
          : 'no_tables_detected — page may require JavaScript; retry with execution_mode: "stealth"';
      return {
        ok: false,
        error: 'no_tables_detected',
        error_reason: 'No tables found on page',
        stage: 'extract',
        hint,
      };
    }

    return buildSuccessOutput(data, sourceUrl, mode, input.max_tokens_out, undefined, _start);
  } catch (err) {
    log.error('Extract failed', { url: input.url, error: String(err) });
    return {
      ok: false,
      error: 'extract_failed',
      error_reason: err instanceof Error ? err.message : String(err),
      stage: 'extract',
    };
  }
}
