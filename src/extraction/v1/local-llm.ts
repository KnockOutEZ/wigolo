import { createLogger } from '../../logger.js';
import { runLlmJson } from '../../integrations/cloud/llm/run.js';
import type { LocalModelTier } from '../../integrations/cloud/llm/local-tier.js';
import { extractStructured } from '../structured.js';
import { htmlToMarkdown } from '../markdown.js';
import type { StructuredData } from '../../types.js';

const log = createLogger('extract');

// Bounded context for the single local-model call. The model receives the
// deterministic pre-extraction (compact) plus trimmed page markdown — NOT a raw
// HTML slice — so it reasons over already-extracted structure within a fixed
// budget rather than re-parsing noisy markup.
export const MAX_MARKDOWN_CHARS = 6000;
const MAX_STRUCTURED_CHARS = 8000;
const REQUEST_TIMEOUT_MS = 30_000;

export interface LocalLlmRequest {
  schema: Record<string, unknown>;
  html: string;
  url: string;
  /** Resolved local-model tier (endpoint + model) from resolveLocalModelTier. */
  tier: LocalModelTier;
}

// Compact, human-readable serialization of the deterministic structured brief.
// Only the populated sections are emitted so a page with just a pricing table
// doesn't waste the budget on empty `definitions`/`chart_hints` scaffolding.
function serializeStructured(data: StructuredData): string {
  const parts: string[] = [];
  if (data.tables.length > 0) {
    for (const t of data.tables) {
      const caption = t.caption ? `Table: ${t.caption}` : 'Table';
      const header = t.headers.length > 0 ? t.headers.join(' | ') : '';
      const rows = t.rows.map((r) =>
        t.headers.map((h) => r[h] ?? '').join(' | '),
      );
      parts.push([caption, header, ...rows].filter(Boolean).join('\n'));
    }
  }
  if (data.key_value_pairs.length > 0) {
    parts.push(
      'Key-value:\n' +
        data.key_value_pairs.map((kv) => `${kv.key}: ${kv.value}`).join('\n'),
    );
  }
  if (data.definitions.length > 0) {
    parts.push(
      'Definitions:\n' +
        data.definitions.map((d) => `${d.term}: ${d.description}`).join('\n'),
    );
  }
  if (data.jsonld.length > 0) {
    parts.push('JSON-LD:\n' + JSON.stringify(data.jsonld));
  }
  const out = parts.join('\n\n');
  return out.length > MAX_STRUCTURED_CHARS ? out.slice(0, MAX_STRUCTURED_CHARS) : out;
}

function buildPrompt(request: LocalLlmRequest): string {
  const structured = serializeStructured(extractStructured(request.html));
  const md = htmlToMarkdown(request.html);
  const markdown = md.length > MAX_MARKDOWN_CHARS ? md.slice(0, MAX_MARKDOWN_CHARS) : md;

  return (
    'Extract data matching the JSON schema from the page below. ' +
    'Use ONLY facts present in the extracted structure and page text. ' +
    'Return only the JSON object — no prose, no markdown fences.\n\n' +
    `URL: ${request.url}\n\n` +
    (structured ? `Extracted structure:\n${structured}\n\n` : '') +
    `Page text:\n${markdown}`
  );
}

/**
 * Ask the local model to fill a schema from the DETERMINISTIC pre-extraction of
 * a page (structured brief + trimmed markdown) rather than raw HTML. The result
 * is parsed + validated against the schema by runLlmJson. On any failure —
 * timeout, non-200, invalid JSON, transport error — this returns `null` so the
 * caller falls back to the deterministic path. Never throws.
 *
 * Endpoint bridge: runLlmJson routes to its endpoint via WIGOLO_LLM_PROVIDER.
 * The resolved tier's endpoint/model are the source of truth here (a keyless
 * run sets only WIGOLO_LOCAL_LLM), so the tier endpoint is applied to
 * WIGOLO_LLM_PROVIDER for exactly this one call and restored afterward — no
 * ambient env mutation survives, keeping every downstream path byte-for-byte.
 */
export async function extractWithLocalLlm(
  request: LocalLlmRequest,
): Promise<Record<string, unknown> | null> {
  const prompt = buildPrompt(request);
  const prevProvider = process.env.WIGOLO_LLM_PROVIDER;
  process.env.WIGOLO_LLM_PROVIDER = request.tier.endpoint;
  try {
    const r = await runLlmJson({
      prompt,
      jsonSchema: request.schema,
      modelOverride: request.tier.model,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    return r.values;
  } catch (err) {
    log.warn('local llm schema extraction failed — falling back to deterministic', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  } finally {
    if (prevProvider === undefined) delete process.env.WIGOLO_LLM_PROVIDER;
    else process.env.WIGOLO_LLM_PROVIDER = prevProvider;
  }
}
