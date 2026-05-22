// Unified entry point for LLM calls across wigolo. Selects a backend from
// env and delegates:
//   - cloud provider name (anthropic/openai/gemini/groq) → SDK adapter
//   - OpenAI-compatible URL (http://...)               → POST /v1/chat/completions
//
// Used by research synthesis, agent synthesis, and v1 extract LLM fallback
// so a single WIGOLO_LLM_PROVIDER configuration drives every code path.

import { TEXT_ADAPTERS, type TextCallResult } from './text-adapters.js';
import { selectProvider, providerEnvVar } from './select.js';
import { resolveModel } from './model-select.js';
import type { LLMProvider } from './types.js';
import { createLogger } from '../../../logger.js';

const log = createLogger('providers');

const DEFAULT_TIMEOUT_MS = 60_000;

export interface RunLlmTextOpts {
  prompt: string;
  maxTokens?: number;
  modelOverride?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface RunLlmTextResult {
  text: string;
  provider: LLMProvider | 'custom';
  model: string;
  latencyMs: number;
}

export interface RunLlmJsonOpts extends RunLlmTextOpts {
  jsonSchema?: Record<string, unknown>;
}

export interface RunLlmJsonResult {
  values: Record<string, unknown>;
  provider: LLMProvider | 'custom';
  model: string;
  latencyMs: number;
}

export function isLlmConfigured(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.WIGOLO_LLM_PROVIDER;
  if (raw && (raw.startsWith('http://') || raw.startsWith('https://'))) return true;
  return selectProvider(env) !== null;
}

function pickBackend(env: Record<string, string | undefined>): { type: 'cloud'; provider: LLMProvider } | { type: 'custom'; url: string } | null {
  const raw = env.WIGOLO_LLM_PROVIDER;
  if (raw && (raw.startsWith('http://') || raw.startsWith('https://'))) {
    return { type: 'custom', url: raw };
  }
  const provider = selectProvider(env);
  if (provider) return { type: 'cloud', provider };
  return null;
}

function buildSignal(opts: { timeoutMs?: number; signal?: AbortSignal }): AbortSignal | undefined {
  if (opts.signal) return opts.signal;
  if (opts.timeoutMs) return AbortSignal.timeout(opts.timeoutMs);
  return AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
}

export async function runLlmText(opts: RunLlmTextOpts): Promise<RunLlmTextResult> {
  const backend = pickBackend(process.env);
  if (!backend) {
    throw new Error('No LLM configured — set WIGOLO_LLM_PROVIDER or a provider API key');
  }
  const signal = buildSignal(opts);

  if (backend.type === 'cloud') {
    const apiKey = process.env[providerEnvVar(backend.provider)] as string;
    const model = resolveModel(backend.provider, opts.modelOverride);
    log.debug('runLlmText cloud', { provider: backend.provider, model });
    const r: TextCallResult = await TEXT_ADAPTERS[backend.provider](
      { prompt: opts.prompt, model, maxTokens: opts.maxTokens, signal },
      apiKey,
    );
    return { text: r.text, provider: r.provider, model: r.model, latencyMs: r.latencyMs };
  }

  // Custom OpenAI-compatible URL backend (e.g. Ollama, vLLM, LM Studio).
  const endpoint = backend.url.includes('/chat/completions')
    ? backend.url
    : backend.url.replace(/\/+$/, '') + '/v1/chat/completions';
  const model = opts.modelOverride ?? process.env.WIGOLO_LLM_MODEL ?? 'local';
  log.debug('runLlmText custom', { url: endpoint, model });
  const start = Date.now();
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: opts.prompt }],
      max_tokens: opts.maxTokens,
    }),
    signal,
  });
  if (!response.ok) throw new Error(`Local LLM endpoint returned ${response.status}`);
  const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const text = payload.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new Error('Local LLM response missing message content');
  }
  return { text, provider: 'custom', model, latencyMs: Date.now() - start };
}

export async function runLlmJson(opts: RunLlmJsonOpts): Promise<RunLlmJsonResult> {
  const schemaText = opts.jsonSchema ? `\nReturn JSON matching this schema:\n${JSON.stringify(opts.jsonSchema)}` : '';
  const wrapped = `${opts.prompt}\n\nReturn ONLY valid JSON, no prose.${schemaText}`;
  const r = await runLlmText({ ...opts, prompt: wrapped });
  let values: unknown;
  try {
    values = JSON.parse(stripJsonFences(r.text));
  } catch (e) {
    throw new Error(`LLM returned invalid JSON: ${(e as Error).message}`);
  }
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw new Error('LLM response is not a JSON object');
  }
  return {
    values: values as Record<string, unknown>,
    provider: r.provider,
    model: r.model,
    latencyMs: r.latencyMs,
  };
}

function stripJsonFences(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]+?)\s*```$/);
  if (fenced) return fenced[1];
  return trimmed;
}
