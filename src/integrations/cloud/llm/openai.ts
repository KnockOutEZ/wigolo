import OpenAI from 'openai';
import { getConfig } from '../../../config.js';
import type { LLMCallOpts, LLMExtractResult } from './types.js';

const DEFAULT_MODEL = 'gpt-4o-mini';

export async function callOpenAI(
  opts: LLMCallOpts,
  apiKey: string,
): Promise<LLMExtractResult> {
  const client = new OpenAI({ apiKey });
  const model = opts.modelOverride ?? DEFAULT_MODEL;
  const start = Date.now();

  const response = await client.chat.completions.create(
    {
      model,
      messages: [{ role: 'user', content: opts.prompt }],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'extract',
          schema: opts.jsonSchema,
          strict: true,
        },
      },
    },
    { signal: opts.signal },
  );

  const content = response.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('openai: empty content in response');
  }

  let values: Record<string, unknown>;
  try {
    values = JSON.parse(content);
  } catch (e) {
    throw new Error(`openai: invalid JSON in response: ${(e as Error).message}`);
  }

  return {
    values,
    provider: 'openai',
    model: response.model ?? model,
    cached: false,
    latencyMs: Date.now() - start,
  };
}

export async function callOpenAICompatible(
  opts: LLMCallOpts,
  apiKey: string,
): Promise<LLMExtractResult> {
  // OpenAI-compatible endpoint via WIGOLO_LLM_BASE_URL, with the API key sent
  // as a Bearer token (unlike the keyless ollama/custom backend).
  const baseURL = getConfig().llmBaseUrl ?? undefined;
  if (!baseURL) {
    throw new Error(
      'openai-compatible: WIGOLO_LLM_BASE_URL is not set; point it at your OpenAI-compatible /v1 endpoint',
    );
  }
  const client = new OpenAI({ apiKey, baseURL });
  const model = opts.modelOverride ?? DEFAULT_MODEL;
  const start = Date.now();

  const response = await client.chat.completions.create(
    {
      model,
      messages: [{ role: 'user', content: opts.prompt }],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'extract',
          schema: opts.jsonSchema,
          strict: true,
        },
      },
    },
    { signal: opts.signal },
  );

  const content = response.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('openai-compatible: empty content in response');
  }

  let values: Record<string, unknown>;
  try {
    values = JSON.parse(content);
  } catch (e) {
    throw new Error(`openai-compatible: invalid JSON in response: ${(e as Error).message}`);
  }

  return {
    values,
    provider: 'openai-compatible',
    model: response.model ?? model,
    cached: false,
    latencyMs: Date.now() - start,
  };
}
