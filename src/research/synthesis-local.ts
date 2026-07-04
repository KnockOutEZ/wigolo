import { createLogger } from '../logger.js';
import { isLlmConfiguredWithKeyStore, runLlmText } from '../integrations/cloud/llm/run.js';

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
  /**
   * Opt-in local-model tier (from resolveLocalModelTier). When present, the
   * keystore gate is bypassed and runLlmText is routed at this endpoint/model —
   * enabling synthesis when only WIGOLO_LOCAL_LLM is on (no cloud key, no
   * explicit WIGOLO_LLM_PROVIDER).
   */
  tier?: { endpoint: string; model: string };
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
  // A local-model tier is self-configuring: it carries its own endpoint/model,
  // so it bypasses the keystore gate (that gate only knows about cloud keys and
  // an explicit WIGOLO_LLM_PROVIDER). Without a tier, require a configured LLM.
  if (!opts.tier && !(await isLlmConfiguredWithKeyStore())) {
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
    'You are a research assistant. Answer the question in flowing prose using ONLY ' +
    'the numbered sources below.\n' +
    'FORMAT + CITATION RULES (mandatory):\n' +
    '- Do NOT write a numbered or bulleted list, do NOT use section headings, and ' +
    'do NOT restate the source titles.\n' +
    '- Support every sentence with a citation: append the supporting source ' +
    'number(s) in square brackets at the END of each sentence, e.g. "Tokio uses a ' +
    'work-stealing scheduler [1]." A single sentence may cite multiple sources, ' +
    'e.g. [1][2].\n' +
    '- Never write a factual sentence without a trailing [N] citation.\n\n' +
    `Question: ${question}\n\n` +
    `Sources:\n${sourceBlocks.join('\n\n')}`;

  try {
    // A tier routes via the additive `backend` override — a single-call endpoint
    // that reads/mutates NO process.env, so concurrent synthesis calls can never
    // corrupt a shared WIGOLO_LLM_PROVIDER. Without a tier, the existing
    // env/keystore resolution is preserved exactly.
    const result = await runLlmText({
      prompt,
      maxTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
      modelOverride: opts.tier?.model ?? opts.modelOverride,
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ...(opts.tier ? { backend: { url: opts.tier.endpoint, model: opts.tier.model } } : {}),
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
