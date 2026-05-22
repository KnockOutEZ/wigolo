import { createLogger } from '../logger.js';
import { isLlmConfigured, runLlmText } from '../integrations/cloud/llm/run.js';

const log = createLogger('research');

const DEFAULT_MAX_SOURCES = 8;
const DEFAULT_MAX_CHARS_PER_SOURCE = 4000;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_TOKENS = 3000;

export interface LocalSynthesisOptions {
  maxSources?: number;
  maxCharsPerSource?: number;
  timeoutMs?: number;
  maxTokens?: number;
  modelOverride?: string;
}

export interface LocalSynthesisSource {
  url: string;
  title: string;
  markdown: string;
}

export interface LocalSynthesisResult {
  text: string;
  citations: number[];
}

export async function synthesizeLocal(
  question: string,
  sources: LocalSynthesisSource[],
  opts: LocalSynthesisOptions = {},
): Promise<LocalSynthesisResult> {
  if (!isLlmConfigured()) {
    throw new Error('LLM not configured. Set WIGOLO_LLM_PROVIDER or a provider API key.');
  }

  const maxSources = opts.maxSources ?? DEFAULT_MAX_SOURCES;
  const maxCharsPerSource = opts.maxCharsPerSource ?? DEFAULT_MAX_CHARS_PER_SOURCE;

  const sliced = sources.slice(0, maxSources);
  const sourceBlocks = sliced.map((s, i) => {
    const body = s.markdown.length > maxCharsPerSource
      ? s.markdown.slice(0, maxCharsPerSource)
      : s.markdown;
    return `[${i + 1}] ${s.title}\n${body}`;
  });

  const prompt =
    'You answer questions using ONLY the provided sources. Cite each fact with [N] where N is the source number.\n\n' +
    `Question: ${question}\n\n` +
    `Sources:\n${sourceBlocks.join('\n\n')}`;

  try {
    const result = await runLlmText({
      prompt,
      maxTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
      modelOverride: opts.modelOverride,
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    log.info('local synthesis ok', { provider: result.provider, model: result.model, latencyMs: result.latencyMs });
    return { text: result.text, citations: extractCitations(result.text) };
  } catch (err) {
    log.error('local synthesis request failed', { error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

// Backwards-compat shim — callers (research/pipeline.ts) used isLocalLlmEnabled()
// to gate this fallback. Keep the same gate name pointing at the unified runner.
export function isLocalLlmEnabled(): boolean {
  return isLlmConfigured();
}

function extractCitations(text: string): number[] {
  const matches = text.match(/\[(\d+)\]/g);
  if (!matches) return [];
  const seen = new Set<number>();
  const out: number[] = [];
  for (const m of matches) {
    const n = Number(m.slice(1, -1));
    if (!Number.isFinite(n) || n < 1) continue;
    const idx = n - 1;
    if (seen.has(idx)) continue;
    seen.add(idx);
    out.push(idx);
  }
  return out;
}
