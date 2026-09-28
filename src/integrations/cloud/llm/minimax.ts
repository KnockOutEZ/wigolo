// MiniMax cloud LLM provider (OpenAI-compatible, authenticated).
//
// Unlike the keyless custom-URL backend in custom-backend.ts — which sends NO
// Authorization header — MiniMax is an authenticated cloud provider: the OpenAI
// SDK attaches `Authorization: Bearer <MINIMAX_API_KEY>` to every request. The
// key is resolved through the standard keychain → file → env chain like every
// other cloud provider.
//
// Two OpenAI-compatible regional endpoints are supported (global + mainland
// China). The region is picked with WIGOLO_MINIMAX_REGION, or the base URL is
// overridden wholesale with WIGOLO_MINIMAX_BASE_URL.

import OpenAI from 'openai';
import type { LLMCallOpts, LLMExtractResult } from './types.js';
import { validateAgainstSchema, type ValidationError } from './validate.js';

/** Default text model when none is configured (WIGOLO_LLM_MODEL_MINIMAX / override). */
export const DEFAULT_MODEL = 'MiniMax-M3';

/** MiniMax text models wigolo recognizes, highest-capability first. */
export const MINIMAX_MODELS = ['MiniMax-M3', 'MiniMax-M2.7'] as const;

export type MiniMaxRegion = 'global_en' | 'cn_zh';

/** OpenAI-compatible base URL per region. */
export const MINIMAX_ENDPOINTS: Record<MiniMaxRegion, string> = {
  global_en: 'https://api.minimax.io/v1',
  cn_zh: 'https://api.minimaxi.com/v1',
};

export const DEFAULT_MINIMAX_REGION: MiniMaxRegion = 'global_en';

function isRegion(v: string | undefined): v is MiniMaxRegion {
  return v === 'global_en' || v === 'cn_zh';
}

/**
 * Resolve the OpenAI-compatible base URL for MiniMax:
 *   1. WIGOLO_MINIMAX_BASE_URL — explicit override (any OpenAI-compatible URL)
 *   2. WIGOLO_MINIMAX_REGION   — 'global_en' (default) or 'cn_zh'
 *   3. the global endpoint
 */
export function resolveMiniMaxBaseUrl(
  env: Record<string, string | undefined> = process.env,
): string {
  const override = env.WIGOLO_MINIMAX_BASE_URL;
  if (override && override.length > 0) return override;
  const region = env.WIGOLO_MINIMAX_REGION;
  if (isRegion(region)) return MINIMAX_ENDPOINTS[region];
  return MINIMAX_ENDPOINTS[DEFAULT_MINIMAX_REGION];
}

/**
 * Structured extract call. MiniMax's OpenAI-compatible endpoint supports
 * `response_format: { type: 'json_object' }` but not OpenAI's strict
 * `json_schema` mode, so — like the Groq adapter — we validate the response
 * against the schema ourselves and retry once with the errors fed back.
 */
export async function callMiniMax(
  opts: LLMCallOpts,
  apiKey: string,
): Promise<LLMExtractResult> {
  const client = new OpenAI({ apiKey, baseURL: resolveMiniMaxBaseUrl() });
  const model = opts.modelOverride ?? DEFAULT_MODEL;
  const start = Date.now();

  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
    { role: 'user', content: buildPrompt(opts.prompt, opts.jsonSchema) },
  ];

  const first = await runOnce(client, model, messages, opts.signal);
  let errors = validateAgainstSchema(first.values, opts.jsonSchema);
  if (errors.length === 0) {
    return done(first.values, first.responseModel ?? model, start);
  }

  messages.push({ role: 'assistant', content: first.raw });
  messages.push({ role: 'user', content: retryPrompt(errors) });

  const second = await runOnce(client, model, messages, opts.signal);
  errors = validateAgainstSchema(second.values, opts.jsonSchema);
  if (errors.length > 0) {
    throw new Error(
      `minimax: response failed schema validation after retry: ${formatErrors(errors)}`,
    );
  }
  return done(second.values, second.responseModel ?? model, start);
}

interface CallOnceResult {
  values: Record<string, unknown>;
  raw: string;
  responseModel: string | undefined;
}

async function runOnce(
  client: OpenAI,
  model: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  signal: AbortSignal | undefined,
): Promise<CallOnceResult> {
  const response = await client.chat.completions.create(
    {
      model,
      messages,
      response_format: { type: 'json_object' },
    },
    { signal },
  );
  const content = response.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('minimax: empty content in response');
  }
  let values: Record<string, unknown>;
  try {
    values = JSON.parse(content);
  } catch (e) {
    throw new Error(`minimax: invalid JSON in response: ${(e as Error).message}`);
  }
  return { values, raw: content, responseModel: response.model };
}

function buildPrompt(prompt: string, schema: Record<string, unknown>): string {
  return `${prompt}\n\nReturn JSON matching this schema:\n${JSON.stringify(schema)}`;
}

function retryPrompt(errors: ValidationError[]): string {
  return `Your previous response failed schema validation:\n${formatErrors(errors)}\nReturn corrected JSON only.`;
}

function formatErrors(errors: ValidationError[]): string {
  return errors.map((e) => `${e.path}: ${e.message}`).join('; ');
}

function done(
  values: Record<string, unknown>,
  model: string,
  start: number,
): LLMExtractResult {
  return {
    values,
    provider: 'minimax',
    model,
    cached: false,
    latencyMs: Date.now() - start,
  };
}
