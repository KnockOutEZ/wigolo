import type { ExtractInput, ExtractOutput, StageResult, StageError, TableData } from '../types.js';
import { isStageError } from '../fetch/error-describe.js';
import type { SmartRouter } from '../fetch/router.js';
import { guardNavigation, type NavSource } from '../security/ssrf.js';
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

// Result of a budget clamp: the trimmed payload plus signals for the caller.
// `truncated` mirrors the clampTablesToChars precedent; `warnings` names every
// budget-driven drop in human-readable, capability-language terms.
interface ClampResult {
  data: ExtractOutput['data'];
  truncated: boolean;
  warnings: string[];
}

// A value is a TableData when it carries a headers[] + rows[] pair. Row-drop
// degradation preserves the table shape (caption + headers) instead of dropping
// the whole structure the way a generic array trim would.
function isTableData(v: unknown): v is TableData {
  return (
    typeof v === 'object' &&
    v !== null &&
    Array.isArray((v as { headers?: unknown }).headers) &&
    Array.isArray((v as { rows?: unknown }).rows)
  );
}

function isTableDataArray(v: unknown): v is TableData[] {
  return Array.isArray(v) && v.length > 0 && v.every(isTableData);
}

// Token-budgeted sibling of clampTablesToChars. Drops rows tail-first across a
// TableData[] preserving every surviving table's caption + headers; a whole
// trailing table is dropped only after its rows are gone. Returns the kept
// tables plus counts so the caller can build a precise warning.
function clampTablesToTokens(
  tables: TableData[],
  maxTokens: number,
): { data: TableData[]; keptRows: number; totalRows: number; keptTables: number; totalTables: number } {
  const totalTables = tables.length;
  const totalRows = tables.reduce((n, t) => n + t.rows.length, 0);
  const work = tables.map((t) => ({
    caption: t.caption,
    headers: [...t.headers],
    rows: [...t.rows],
  })) as TableData[];

  // Running-size accounting keeps the hot loop O(N): summing per-row token
  // counts drifts low (the tokenizer merges tokens across row boundaries), so
  // after the fast loop drains the estimated budget we re-sync `size` to the
  // true measurement and resume. A handful of re-syncs converges — the true
  // measurement count is bounded by re-sync rounds (small), not by row count.
  const pop = (): number => {
    const last = work[work.length - 1];
    if (last.rows.length > 0) {
      const popped = last.rows.pop();
      return countTokens(JSON.stringify(popped)) + 1;
    }
    const poppedCost = countTokens(JSON.stringify(last)) + 1;
    work.pop();
    return poppedCost;
  };
  let size = countTokens(JSON.stringify(work));
  while (size > maxTokens && work.length > 0) {
    while (size > maxTokens && work.length > 0) size -= pop();
    size = countTokens(JSON.stringify(work)); // reconcile drift, resume if still over
  }

  // Degenerate budget: even a headers-only table won't fit. Keep the first
  // table's structure (caption + headers, zero rows) so the caller still learns
  // the shape rather than getting a bare []. The drop is always signaled.
  if (work.length === 0 && totalTables > 0) {
    work.push({ caption: tables[0].caption, headers: [...tables[0].headers], rows: [] });
  }

  const keptRows = work.reduce((n, t) => n + t.rows.length, 0);
  return { data: work, keptRows, totalRows, keptTables: work.length, totalTables };
}

// Trim a structured extraction payload to fit within `maxTokens`.
//   - TableData[]: drop rows tail-first (preserve caption + headers).
//   - other arrays: keep leading items until budget exhausted, then stop.
//   - objects with array fields (StructuredData): trim table fields via
//     row-dropping and other array fields prefix-first; oversize strings get
//     truncated in place so a huge `body` never vanishes entirely.
//   - primitives: returned untouched.
// Returns a shallow copy plus drop signals; never mutates the input.
function clampExtractData(
  data: ExtractOutput['data'],
  maxTokens: number,
): ClampResult {
  if (data === null || data === undefined) return { data, truncated: false, warnings: [] };
  const total = countTokens(JSON.stringify(data));
  if (total <= maxTokens) return { data, truncated: false, warnings: [] };

  if (isTableDataArray(data)) {
    const r = clampTablesToTokens(data, maxTokens);
    const warnings = [tableTrimWarning(r)];
    return { data: r.data as ExtractOutput['data'], truncated: true, warnings };
  }

  if (Array.isArray(data)) {
    const out: unknown[] = [];
    let used = 2; // [] brackets
    for (const item of data) {
      const t = countTokens(JSON.stringify(item)) + 1; // comma
      if (used + t > maxTokens) break;
      out.push(item);
      used += t;
    }
    const warnings =
      out.length < data.length
        ? [`output trimmed to fit max_tokens_out: kept ${out.length} of ${data.length} items`]
        : [];
    return { data: out as ExtractOutput['data'], truncated: true, warnings };
  }

  if (typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    const warnings: string[] = [];
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
    // Then fill array fields, biggest-first. Table-shaped fields degrade by
    // row-dropping (keep headers); other array fields keep leading items. Every
    // originally-non-empty field that ends up empty or short is named in a
    // warning so no drop is silent.
    arrayKeys.sort((a, b) =>
      countTokens(JSON.stringify(obj[b])) - countTokens(JSON.stringify(obj[a])),
    );
    for (const k of arrayKeys) {
      const arr = obj[k] as unknown[];
      if (arr.length === 0) {
        out[k] = [];
        continue;
      }
      const remaining = Math.max(0, maxTokens - used);
      if (isTableDataArray(arr)) {
        const r = clampTablesToTokens(arr, remaining);
        out[k] = r.data;
        used += countTokens(JSON.stringify(r.data)) + 1;
        if (r.keptRows < r.totalRows || r.keptTables < r.totalTables) {
          warnings.push(`${k}: ${tableTrimWarning(r)}`);
        }
      } else {
        const kept: unknown[] = [];
        for (const item of arr) {
          const t = countTokens(JSON.stringify(item)) + 1;
          if (used + t > maxTokens) break;
          kept.push(item);
          used += t;
        }
        out[k] = kept;
        if (kept.length < arr.length) {
          warnings.push(
            `output trimmed to fit max_tokens_out: kept ${kept.length} of ${arr.length} ${k}`,
          );
        }
      }
    }
    if (warnings.length === 0) {
      // Only oversize strings were truncated — signal the clip without an
      // array-drop message the caller could misread as data loss.
      warnings.push('output trimmed to fit max_tokens_out');
    }
    return { data: out as ExtractOutput['data'], truncated: true, warnings };
  }

  return { data, truncated: true, warnings: ['output trimmed to fit max_tokens_out'] };
}

function tableTrimWarning(r: {
  keptRows: number;
  totalRows: number;
  keptTables: number;
  totalTables: number;
}): string {
  const parts = [`output trimmed to fit max_tokens_out: kept ${r.keptRows} of ${r.totalRows} table rows`];
  if (r.keptTables < r.totalTables) {
    parts.push(`dropped ${r.totalTables - r.keptTables} of ${r.totalTables} tables`);
  }
  return parts.join('; ');
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
  const allWarnings = warnings ? [...warnings] : [];
  if (maxTokens !== undefined) {
    const clamped = clampExtractData(data, maxTokens);
    finalData = clamped.data;
    truncated = clamped.truncated;
    allWarnings.push(...clamped.warnings);
  } else if (mode === 'tables') {
    // Default-cap path for tables — only runs when the caller didn't pass an
    // explicit budget. Surfaces `truncated: true` on clip so callers can detect.
    const clamped = clampTablesToChars(data, TABLES_DEFAULT_MAX_CHARS);
    finalData = clamped.data;
    truncated = clamped.truncated;
  }
  const out: ExtractOutput = { data: finalData, source_url: sourceUrl, mode };
  if (allWarnings.length > 0) out.warnings = allWarnings;
  if (typeof startMs === 'number') out.response_time_ms = Date.now() - startMs;
  if (truncated) out.truncated = true;
  return { ok: true, data: out };
}

/**
 * Resolve the HTML to extract from. Returns a StageError when the fetch was REFUSED: extract
 * has a StageResult return type precisely so a refusal can be reported as one, and passing
 * `undefined` html into the extractors would instead have produced a successful-looking
 * response with an empty table/metadata payload.
 */
async function resolveHtml(
  input: ExtractInput,
  router: SmartRouter,
  source: NavSource = 'agent',
): Promise<{ html: string; sourceUrl?: string } | StageError> {
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
      source,
    });
    if (isStageError(raw)) return raw;
    return { html: raw.html, sourceUrl: raw.finalUrl };
  }

  return { html: input.html! };
}

export async function handleExtract(
  input: ExtractInput,
  router: SmartRouter,
  source: NavSource = 'agent',
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

  // P6-a exfil guard at the handler ENTRY — covers BOTH the stealth path (which fetches via the
  // browser tier, bypassing router.fetch) and the standard path. Source-aware: agent blocks
  // localhost/private; human (REPL) may reach a local dev server; cloud-metadata blocked for both.
  if (input.url) {
    const verdict = guardNavigation(input.url, { source, allowLoopback: true });
    if (!verdict.ok) {
      return {
        ok: false,
        error: 'navigation_blocked',
        error_reason:
          verdict.code === 'blocked'
            ? `Blocked ${source}-initiated extraction of a non-public address: ${verdict.host ?? input.url}`
            : `Invalid extraction target (${verdict.code}): ${input.url}`,
        stage: 'extract',
        hint:
          source === 'agent'
            ? 'Cloud-internal/metadata is never reachable; localhost/private requires a human-initiated request.'
            : 'The address is not a navigable public/local target.',
      };
    }
  }

  try {
    const resolved = await resolveHtml(input, router, source);
    if (isStageError(resolved)) {
      log.warn('extract source refused', {
        url: input.url,
        error: resolved.error,
        reason: resolved.error_reason,
      });
      return { ok: false, ...resolved, stage: 'extract' };
    }
    const { html, sourceUrl } = resolved;

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
