import { getConfig } from '../config.js';
import { callAnthropic } from '../integrations/cloud/llm/anthropic.js';
import { callOpenAI } from '../integrations/cloud/llm/openai.js';
import { callGemini } from '../integrations/cloud/llm/gemini.js';
import { callGroq } from '../integrations/cloud/llm/groq.js';
import {
  ensureLLMCacheTable,
  insertLLMCache,
  lookupLLMCache,
} from '../integrations/cloud/llm/cache.js';
import { hashPrompt, hashSchema } from '../integrations/cloud/llm/hash.js';
import { allProviders, providerEnvVar, selectProviderWithKeyStore } from '../integrations/cloud/llm/select.js';
import type { LLMExtractResult, LLMProvider } from '../integrations/cloud/llm/types.js';
import { validateAgainstSchema } from '../integrations/cloud/llm/validate.js';

const MAX_HTML_BYTES = 50_000;

export interface LLMFallbackBudget {
  remaining: number;
}

export interface LLMFallbackInput {
  html: string;
  jsonSchema: Record<string, unknown>;
  partial: Record<string, unknown>;
  missing: string[];
  signal?: AbortSignal;
  budget?: LLMFallbackBudget;
}

export interface LLMFallbackResult extends LLMExtractResult {
  warnings: string[];
}

const ADAPTERS: Record<
  LLMProvider,
  (
    opts: { prompt: string; jsonSchema: Record<string, unknown>; signal?: AbortSignal },
    apiKey: string,
  ) => Promise<LLMExtractResult>
> = {
  anthropic: callAnthropic,
  openai: callOpenAI,
  gemini: callGemini,
  groq: callGroq,
};

export async function extractWithLLM(
  input: LLMFallbackInput,
): Promise<LLMFallbackResult> {
  if (input.missing.length === 0) {
    return emptyResult(input.partial, []);
  }

  const cfg = getConfig();
  const budget = input.budget ?? { remaining: cfg.llmMaxCallsPerRequest };
  if (budget.remaining <= 0) {
    return emptyResult(input.partial, [
      `LLM fallback skipped: per-request budget exhausted (cap ${cfg.llmMaxCallsPerRequest}). Override via WIGOLO_LLM_MAX_CALLS_PER_REQUEST.`,
    ]);
  }

  // Resolve provider + key through the full keystore chain (keychain → file → env)
  const resolved = await selectProviderWithKeyStore(process.env, { dataDir: cfg.dataDir });
  if (!resolved) {
    const envList = allProviders()
      .map((p) => providerEnvVar(p))
      .join(', ');
    return emptyResult(input.partial, [
      `LLM fallback skipped: no provider key set (${envList}). ` +
        `${input.missing.length} required field(s) still missing: ${input.missing.join(', ')}.`,
    ]);
  }

  const { provider, key: apiKey } = resolved;
  const prompt = buildPrompt(input);
  const promptHash = hashPrompt(prompt);
  const schemaHash = hashSchema(input.jsonSchema);
  const modelId = `${provider}:default`;

  ensureLLMCacheTable();
  const cached = lookupLLMCache(modelId, promptHash, schemaHash);
  if (cached) {
    const values = JSON.parse(cached) as Record<string, unknown>;
    return {
      values: mergeOnlyMissing(input.partial, values, input.missing),
      provider,
      model: modelId,
      cached: true,
      latencyMs: 0,
      warnings: [],
    };
  }

  let result: LLMExtractResult;
  try {
    result = await ADAPTERS[provider](
      { prompt, jsonSchema: input.jsonSchema, signal: input.signal },
      apiKey,
    );
  } catch (e) {
    return emptyResult(input.partial, [
      `LLM fallback (${provider}) failed: ${(e as Error).message}`,
    ]);
  } finally {
    budget.remaining = Math.max(0, budget.remaining - 1);
  }

  const errors = validateAgainstSchema(result.values, input.jsonSchema);
  if (errors.length > 0) {
    return emptyResult(input.partial, [
      `LLM fallback (${provider}) response failed schema validation: ${errors
        .map((e) => `${e.path} ${e.message}`)
        .join('; ')}`,
    ]);
  }

  const ttlMs = cfg.llmCacheTtlDays * 24 * 60 * 60 * 1000;
  const now = Date.now();
  insertLLMCache({
    modelId,
    promptHash,
    schemaHash,
    response: JSON.stringify(result.values),
    createdAt: now,
    expiresAt: now + ttlMs,
  });

  return {
    values: mergeOnlyMissing(input.partial, result.values, input.missing),
    provider,
    model: result.model,
    cached: false,
    latencyMs: result.latencyMs,
    warnings: result.warnings ?? [],
  };
}

function emptyResult(
  partial: Record<string, unknown>,
  warnings: string[],
): LLMFallbackResult {
  return {
    values: { ...partial },
    provider: 'anthropic',
    model: '',
    cached: false,
    latencyMs: 0,
    warnings,
  };
}

function mergeOnlyMissing(
  partial: Record<string, unknown>,
  filled: Record<string, unknown>,
  missing: string[],
): Record<string, unknown> {
  const out = { ...partial };
  for (const key of missing) {
    if (filled[key] !== undefined) out[key] = filled[key];
  }
  return out;
}

function buildPrompt(input: LLMFallbackInput): string {
  const html = truncate(input.html, MAX_HTML_BYTES);
  return [
    'Extract the following missing fields from the HTML below.',
    `Missing fields: ${input.missing.join(', ')}.`,
    'Return JSON matching the provided schema. Do not invent values; if a field is not present in the HTML, omit it.',
    '',
    'HTML:',
    html,
  ].join('\n');
}

function truncate(s: string, maxBytes: number): string {
  if (s.length <= maxBytes) return s;
  return s.slice(0, maxBytes);
}
