import { GoogleGenAI } from '@google/genai';
import type { LLMCallOpts, LLMExtractResult } from './types.js';

const DEFAULT_MODEL = 'gemini-2.5-flash-lite';

export async function callGemini(
  opts: LLMCallOpts,
  apiKey: string,
): Promise<LLMExtractResult> {
  const client = new GoogleGenAI({ apiKey });
  const model = opts.modelOverride ?? DEFAULT_MODEL;
  const start = Date.now();

  const response = await client.models.generateContent({
    model,
    contents: opts.prompt,
    config: {
      responseMimeType: 'application/json',
      responseJsonSchema: opts.jsonSchema,
      abortSignal: opts.signal,
    },
  });

  const text = response.text;
  if (!text) {
    throw new Error('gemini: empty text in response');
  }

  let values: Record<string, unknown>;
  try {
    values = JSON.parse(text);
  } catch (e) {
    throw new Error(`gemini: invalid JSON in response: ${(e as Error).message}`);
  }

  return {
    values,
    provider: 'gemini',
    model,
    cached: false,
    latencyMs: Date.now() - start,
  };
}
