import { createLogger } from '../../logger.js';
import { runLlmJson } from '../../integrations/cloud/llm/run.js';
import type { LocalModelTier } from '../../integrations/cloud/llm/local-tier.js';
import { extractStructured } from '../structured.js';
import { extractContent } from '../pipeline.js';
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

// Main-content markdown for the page-text portion of the prompt. Real pages
// bury the schema-relevant content (e.g. pricing) under a large nav/hero block
// that easily exceeds the char budget, so a raw slice-from-the-top drops the
// substantive region and the model hallucinates. The content extractor strips
// boilerplate so the substantive region survives the budget even when it sits
// late in the raw document. Falls back to raw markdown if extraction yields
// nothing (never throws the extraction path into the model call).
async function pageMarkdown(request: LocalLlmRequest): Promise<string> {
  try {
    const r = await extractContent(request.html, request.url || 'about:blank');
    if (r.markdown && r.markdown.trim().length > 0) return r.markdown;
  } catch {
    // fall through to raw markdown
  }
  return htmlToMarkdown(request.html);
}

async function buildPrompt(request: LocalLlmRequest): Promise<string> {
  const structured = serializeStructured(extractStructured(request.html));
  const md = await pageMarkdown(request);
  const markdown = md.length > MAX_MARKDOWN_CHARS ? md.slice(0, MAX_MARKDOWN_CHARS) : md;

  return (
    'Extract data matching the JSON schema from the page below. ' +
    'Use ONLY facts (names, prices, features) that appear verbatim in the ' +
    'extracted structure or page text — never invent, round, or substitute ' +
    'placeholder values. If a field is not present, omit it. ' +
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
 * The resolved tier's endpoint/model are threaded to runLlmJson via the
 * per-call `backend` override — NOT process.env. That keeps the call routed to
 * the local server without ever mutating ambient env, so concurrent extract
 * calls can never corrupt a shared WIGOLO_LLM_PROVIDER (which would silently
 * reroute cloud→local for every other subsystem for the rest of the process).
 */
export async function extractWithLocalLlm(
  request: LocalLlmRequest,
): Promise<Record<string, unknown> | null> {
  const prompt = await buildPrompt(request);
  try {
    const r = await runLlmJson({
      prompt,
      jsonSchema: request.schema,
      backend: { url: request.tier.endpoint, model: request.tier.model },
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    return r.values;
  } catch (err) {
    log.warn('local llm schema extraction failed — falling back to deterministic', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
