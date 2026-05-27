// Unified entry point for LLM calls across wigolo. Selects a backend from
// env (or keystore) and delegates:
//   - cloud provider name (anthropic/openai/gemini/groq) → SDK adapter
//   - OpenAI-compatible URL (http://...)               → POST /v1/chat/completions
//
// SP4: keys are resolved via resolveProviderKey (keychain → file → env) and
// passed explicitly to adapters. process.env is never hydrated from keystore.
//
// Used by research synthesis, agent synthesis, and v1 extract LLM fallback
// so a single WIGOLO_LLM_PROVIDER configuration drives every code path.

import { TEXT_ADAPTERS, type TextCallResult } from './text-adapters.js';
import { selectProvider, selectProviderWithKeyStore, providerEnvVar } from './select.js';
import { resolveModel } from './model-select.js';
import type { LLMProvider } from './types.js';
import { createLogger } from '../../../logger.js';
import { resolveProviderKey } from '../../../security/key-store.js';
import { getConfig } from '../../../config.js';

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

/**
 * Async variant of isLlmConfigured that also checks the keystore.
 * Use this when you have access to the data dir.
 */
export async function isLlmConfiguredWithKeyStore(
  env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
  const raw = env.WIGOLO_LLM_PROVIDER;
  if (raw && (raw.startsWith('http://') || raw.startsWith('https://'))) return true;
  const cfg = getConfig();
  const result = await selectProviderWithKeyStore(env, { dataDir: cfg.dataDir });
  return result !== null;
}

function pickCustomBackend(env: Record<string, string | undefined>): { type: 'custom'; url: string } | null {
  const raw = env.WIGOLO_LLM_PROVIDER;
  if (raw && (raw.startsWith('http://') || raw.startsWith('https://'))) {
    return { type: 'custom', url: raw };
  }
  return null;
}

function buildSignal(opts: { timeoutMs?: number; signal?: AbortSignal }): AbortSignal | undefined {
  if (opts.signal) return opts.signal;
  if (opts.timeoutMs) return AbortSignal.timeout(opts.timeoutMs);
  return AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
}

const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 529]);
const RETRY_MESSAGE_PATTERN = /\b(429|500|502|503|504|529)\b|too many requests|rate.?limit|unavailable|overloaded|high demand|service unavailable|temporar/i;
const MAX_RETRIES = 2;
const BASE_BACKOFF_MS = 500;

function isTransientError(err: unknown): boolean {
  if (!err) return false;
  const status = (err as { status?: unknown }).status;
  if (typeof status === 'number' && RETRY_STATUS.has(status)) return true;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|ECONNREFUSED/.test(code)) {
    return true;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return RETRY_MESSAGE_PATTERN.test(msg);
}

async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === MAX_RETRIES || !isTransientError(err)) throw err;
      const backoff = BASE_BACKOFF_MS * Math.pow(3, attempt);
      log.warn('LLM call transient failure, retrying', {
        label,
        attempt: attempt + 1,
        backoffMs: backoff,
        error: err instanceof Error ? err.message : String(err),
      });
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastErr;
}

export async function runLlmText(opts: RunLlmTextOpts): Promise<RunLlmTextResult> {
  const cfg = getConfig();
  const ksOpts = { dataDir: cfg.dataDir };
  const signal = buildSignal(opts);

  // Custom URL backend (Ollama, vLLM, LM Studio) — no key needed
  const custom = pickCustomBackend(process.env);
  if (custom) {
    const endpoint = custom.url.includes('/chat/completions')
      ? custom.url
      : custom.url.replace(/\/+$/, '') + '/v1/chat/completions';
    const model = opts.modelOverride ?? process.env.WIGOLO_LLM_MODEL ?? 'local';
    log.debug('runLlmText custom', { url: endpoint, model });
    return withRetry(`custom:${model}`, async () => {
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
      if (!response.ok) {
        const err = new Error(`Local LLM endpoint returned ${response.status}`) as Error & { status?: number };
        err.status = response.status;
        throw err;
      }
      const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const text = payload.choices?.[0]?.message?.content;
      if (typeof text !== 'string' || text.trim().length === 0) {
        throw new Error('Local LLM response missing message content');
      }
      return { text, provider: 'custom' as const, model, latencyMs: Date.now() - start };
    });
  }

  // Cloud provider — resolve key through keystore seam
  const resolved = await selectProviderWithKeyStore(process.env, ksOpts);
  if (!resolved) {
    throw new Error('No LLM configured — set WIGOLO_LLM_PROVIDER or a provider API key');
  }

  const { provider, key: apiKey } = resolved;
  const model = resolveModel(provider, opts.modelOverride);
  log.debug('runLlmText cloud', { provider, model });
  return withRetry(`${provider}:${model}`, async () => {
    const r: TextCallResult = await TEXT_ADAPTERS[provider](
      { prompt: opts.prompt, model, maxTokens: opts.maxTokens, signal },
      apiKey,
    );
    return { text: r.text, provider: r.provider, model: r.model, latencyMs: r.latencyMs };
  });
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

/**
 * Resolve the API key for the currently configured provider through the
 * full keystore chain (keychain → file → env). Returns undefined when no
 * provider is configured.
 *
 * Used by llm-fallback.ts which needs the key + provider separately.
 */
export async function resolveActiveProviderKey(): Promise<{ provider: LLMProvider; key: string } | null> {
  const cfg = getConfig();
  return selectProviderWithKeyStore(process.env, { dataDir: cfg.dataDir });
}

// Re-export resolveProviderKey for direct use by llm-fallback
export { resolveProviderKey } from '../../../security/key-store.js';
