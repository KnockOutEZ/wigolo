import { createLogger } from '../logger.js';
import { isLlmConfiguredWithKeyStore, runLlmText } from '../integrations/cloud/llm/run.js';
import { wrapUntrusted } from '../security/untrusted.js';

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
  if (!(await isLlmConfiguredWithKeyStore())) {
    throw new Error('LLM not configured. Set WIGOLO_LLM_PROVIDER or a provider API key.');
  }

  const maxSources = opts.maxSources ?? DEFAULT_MAX_SOURCES;
  const maxCharsPerSource = opts.maxCharsPerSource ?? DEFAULT_MAX_CHARS_PER_SOURCE;

  const sliced = sources.slice(0, maxSources);
  const sourceBlocks = sliced.map((s, i) => {
    const body = s.markdown.length > maxCharsPerSource
      ? s.markdown.slice(0, maxCharsPerSource)
      : s.markdown;
    // D8a: the page body is embedded INSIDE the untrusted-data fence (same treatment as
    // research/synthesize.ts) so an injected directive can't be read as an instruction. Truncate
    // BEFORE wrapping (above) so the closing marker is never severed. Flag-independent by design.
    return `[${i + 1}] ${s.title}\n${wrapUntrusted(body)}`;
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

// Backwards-compat shim — callers used isLocalLlmEnabled() to gate this
// fallback. Keystore-aware so a zero-env (config.json + keychain) setup reports
// enabled. No remaining in-tree callers; kept for external compatibility.
export async function isLocalLlmEnabled(): Promise<boolean> {
  return isLlmConfiguredWithKeyStore();
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
