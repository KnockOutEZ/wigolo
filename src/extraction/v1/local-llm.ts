import { createLogger } from '../../logger.js';
import { isLlmConfigured, runLlmJson } from '../../integrations/cloud/llm/run.js';

const log = createLogger('extract');

const MAX_HTML_CHARS = 50000;
const REQUEST_TIMEOUT_MS = 30_000;

export function isLocalLlmEnabled(): boolean {
  return isLlmConfigured();
}

export interface LocalLlmRequest {
  schema: Record<string, unknown>;
  html: string;
  url: string;
}

export async function extractWithLocalLlm(
  request: LocalLlmRequest,
): Promise<Record<string, unknown> | null> {
  if (!isLocalLlmEnabled()) return null;

  const htmlSlice = request.html.length > MAX_HTML_CHARS
    ? request.html.slice(0, MAX_HTML_CHARS)
    : request.html;

  const prompt =
    'Extract data matching the JSON schema from the HTML below. ' +
    'Return only the JSON object — no prose, no markdown fences.\n\n' +
    `URL: ${request.url}\n\n` +
    `HTML:\n${htmlSlice}`;

  try {
    const r = await runLlmJson({
      prompt,
      jsonSchema: request.schema,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    return r.values;
  } catch (err) {
    log.error('local llm request failed', { error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}
