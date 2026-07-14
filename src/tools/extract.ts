import type { ExtractInput, ExtractOutput, StageResult, TableData } from '../types.js';
import type { SmartRouter } from '../fetch/router.js';
import { extractMetadata, extractSelector, extractTables } from '../extraction/extract.js';
import {
  extractWithSchema,
  extractWithSchemaDetailed,
  extractWithSchemaDetailedAsync,
} from '../extraction/schema.js';
import { extractJsonLd } from '../extraction/jsonld.js';
import { extractStructured, mergeGridTables } from '../extraction/structured.js';
import { detectDivGridTables } from '../extraction/div-grid.js';
import { getCachedContent, isExpired } from '../cache/store.js';
import { fetchWithPlaywright } from '../fetch/playwright-tier.js';
import { countTokens, truncateByTokens } from '../search/tokens.js';
import { createLogger } from '../logger.js';
import {
  isNamedSchemaType,
  extractNamedSchema,
  NAMED_SCHEMAS,
} from '../extraction/v1/schemas/index.js';
import { extractWithLocalLlm } from '../extraction/v1/local-llm.js';
import { resolveLocalModelTier } from '../integrations/cloud/llm/local-tier.js';
import { extractBrandAsync } from '../extraction/brand.js';
import { applyEvidenceFilter, getSourceText } from '../extraction/schema-truth.js';
import { guardFetchUrl } from '../watch/ssrf.js';
import { getConfig } from '../config.js';

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

// default char ceiling for mode='tables' when caller didn't pass
// max_tokens_out. Large tables blow token budgets; this default keeps the
// response useful for the common case while flipping `truncated: true` so
// callers can detect the clip and re-request explicitly if they need more.
const TABLES_DEFAULT_MAX_CHARS = 30000;

// Trim a tables payload to fit within `maxChars`. Drops rows tail-first while
// preserving the table's header so the structural shape stays intact.
// Exported for direct testing (perf guard against O(N²) re-serialization).
export function clampTablesToChars(
  data: ExtractOutput['data'],
  maxChars: number,
): { data: ExtractOutput['data']; truncated: boolean } {
  if (!Array.isArray(data)) return { data, truncated: false };
  const serialized = JSON.stringify(data);
  if (serialized.length <= maxChars) return { data, truncated: false };

  // Clone shallowly so we don't mutate the source array.
  const tables = (data as TableData[]).map((t) => ({
    caption: t.caption,
    headers: [...t.headers],
    rows: [...t.rows],
  })) as TableData[];

  // Track a running length to avoid O(N²) re-serialization on each pop.
  // The +1 approximates the comma/whitespace separator that JSON.stringify
  // would emit between adjacent elements; exact accuracy isn't required
  // because the cap is a soft target and the final shape stays valid.
  let currentSize = JSON.stringify(tables).length;

  // Pop rows from the last table first; if it empties, pop the table itself.
  while (currentSize > maxChars && tables.length > 0) {
    const last = tables[tables.length - 1];
    if (last.rows.length > 0) {
      const popped = last.rows.pop();
      currentSize -= JSON.stringify(popped).length + 1;
    } else {
      // Capture the table's serialized cost before removing it.
      const poppedSize = JSON.stringify(tables[tables.length - 1]).length + 1;
      tables.pop();
      currentSize -= poppedSize;
    }
  }
  return { data: tables, truncated: true };
}

function buildSuccessOutput(
  data: ExtractOutput['data'],
  sourceUrl: string | undefined,
  mode: ExtractOutput['mode'],
  maxTokens: number | undefined,
  warnings?: string[],
  startMs?: number,
): StageResult<ExtractOutput> {
  let finalData = data;
  let truncated = false;
  if (maxTokens !== undefined) {
    finalData = clampExtractData(data, maxTokens);
  } else if (mode === 'tables') {
    // Default-cap path for tables — only runs when the caller didn't pass an
    // explicit budget. Surfaces `truncated: true` on clip so callers can detect.
    const clamped = clampTablesToChars(data, TABLES_DEFAULT_MAX_CHARS);
    finalData = clamped.data;
    truncated = clamped.truncated;
  }
  const out: ExtractOutput = { data: finalData, source_url: sourceUrl, mode };
  if (warnings && warnings.length > 0) out.warnings = warnings;
  if (typeof startMs === 'number') out.response_time_ms = Date.now() - startMs;
  if (truncated) out.truncated = true;
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
    // SSRF guard — same policy as `fetch`: loopback ok, private LANs blocked
    // by default. Set WIGOLO_FETCH_ALLOW_PRIVATE=1 to opt into permissive.
    const ssrf = guardFetchUrl(input.url, 'url', {
      allowPrivate: getConfig().fetchAllowPrivate,
    });
    if (!ssrf.ok) {
      throw Object.assign(new Error(ssrf.reason), {
        code: 'invalid_url',
        reason: ssrf.reason,
        hint: ssrf.hint,
      });
    }

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

    const localTier =
      mode === 'schema' && input.schema ? await resolveLocalModelTier() : null;
    if (mode === 'schema' && input.schema && localTier) {
      // Structure-first: run the deterministic passes (JSON-LD / microdata /
      // structure fuzzy-match / DOM heuristic) BEFORE the local model, so the
      // model only fills genuine gaps and structured data is never overwritten
      // by a model guess. Structure-sourced fields are trusted; only
      // model-filled fields go through the evidence-only filter. When the tier
      // is null (flag off — the default — or server down) this whole block is
      // skipped and control flows to the deterministic schema path below,
      // byte-for-byte identical to the keyless behavior.
      const det = extractWithSchemaDetailed(html, input.schema);
      const structuredValues: Record<string, unknown> = { ...det.values };
      const missing = Object.keys(input.schema.properties ?? {}).filter(
        (k) => structuredValues[k] === undefined,
      );

      let warnings: string[] | undefined;
      if (missing.length > 0) {
        const llmData = await extractWithLocalLlm({
          schema: input.schema as unknown as Record<string, unknown>,
          html,
          url: sourceUrl ?? input.url ?? '',
          tier: localTier,
        });
        const raw = (llmData ?? {}) as Record<string, unknown>;
        // evidence-only constraint applies to the local-llm path: an LLM can
        // free-form-complete a confidently-wrong value; the verifier nulls
        // any model field not present in the source text. A rejected field is
        // set to null (not dropped) so the caller sees it was attempted and
        // failed verification, not silently absent.
        const modelFilled = missing.filter(
          (k) => raw[k] !== undefined && raw[k] !== null && raw[k] !== '',
        );
        if (modelFilled.length > 0) {
          // Note: applyEvidenceFilter verifies string/number/boolean fields
          // against source but accepts array/object fields by default (see
          // schema-truth.ts). Model-filled nested array/object fields are thus
          // grounded by the prompt (verbatim-facts instruction over the
          // deterministic pre-extraction), not structurally verified here.
          // Array-level evidence verification is out of scope this round.
          const filtered = applyEvidenceFilter({
            values: raw,
            provenance: {},
            sourceText: getSourceText(html),
            fields: modelFilled,
          });
          for (const k of modelFilled) {
            structuredValues[k] = filtered.values[k];
          }
          if (filtered.rejectedFields.length > 0) {
            warnings = [
              `evidence-only filter: nulled ${filtered.rejectedFields.length} ` +
                `field(s) the model proposed but were not present in source text ` +
                `(${filtered.rejectedFields.join(', ')}).`,
            ];
          }
        }
      }
      return buildSuccessOutput(
        structuredValues,
        sourceUrl,
        'schema',
        input.max_tokens_out,
        warnings,
        _start,
      );
    }

    let data: ExtractOutput['data'];

    switch (mode) {
      case 'selector':
        data = extractSelector(html, input.css_selector!, input.multiple ?? false);
        break;
      case 'tables':
        // Merge <table>-derived rows with div/flex-grid card structures so a
        // pricing page built from styled <div>s (no <table>) still returns a
        // per-tier grid instead of an empty result.
        data = mergeGridTables(extractTables(html), detectDivGridTables(html));
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
