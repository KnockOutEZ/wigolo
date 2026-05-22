// Free-form text completion adapters per provider. Returns plain text
// (markdown / prose) without a JSON schema constraint — used by research +
// agent synthesis. The JSON-schema adapters in anthropic.ts/openai.ts/etc.
// stay for extract's structured path.

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import Groq from 'groq-sdk';
import { GoogleGenAI } from '@google/genai';
import type { LLMProvider } from './types.js';

export interface TextCallOpts {
  prompt: string;
  model: string;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface TextCallResult {
  text: string;
  provider: LLMProvider;
  model: string;
  latencyMs: number;
}

const DEFAULT_MAX_TOKENS = 2000;

export async function callAnthropicText(opts: TextCallOpts, apiKey: string): Promise<TextCallResult> {
  const client = new Anthropic({ apiKey });
  const start = Date.now();
  const response = await client.messages.create(
    {
      model: opts.model,
      max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: [{ role: 'user', content: opts.prompt }],
    },
    { signal: opts.signal },
  );
  const block = (response.content ?? []).find((b: { type: string }) => b.type === 'text') as
    | { type: 'text'; text: string }
    | undefined;
  if (!block) throw new Error('anthropic: no text block in response');
  return {
    text: block.text,
    provider: 'anthropic',
    model: response.model ?? opts.model,
    latencyMs: Date.now() - start,
  };
}

export async function callOpenAIText(opts: TextCallOpts, apiKey: string): Promise<TextCallResult> {
  const client = new OpenAI({ apiKey });
  const start = Date.now();
  const response = await client.chat.completions.create(
    {
      model: opts.model,
      max_completion_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: [{ role: 'user', content: opts.prompt }],
    },
    { signal: opts.signal },
  );
  const text = response.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new Error('openai: empty content in response');
  }
  return {
    text,
    provider: 'openai',
    model: response.model ?? opts.model,
    latencyMs: Date.now() - start,
  };
}

export async function callGeminiText(opts: TextCallOpts, apiKey: string): Promise<TextCallResult> {
  const client = new GoogleGenAI({ apiKey });
  const start = Date.now();
  const response = await client.models.generateContent({
    model: opts.model,
    contents: opts.prompt,
    config: {
      maxOutputTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
      abortSignal: opts.signal,
    },
  });
  const text = response.text;
  if (!text || text.trim().length === 0) throw new Error('gemini: empty text in response');
  return {
    text,
    provider: 'gemini',
    model: opts.model,
    latencyMs: Date.now() - start,
  };
}

export async function callGroqText(opts: TextCallOpts, apiKey: string): Promise<TextCallResult> {
  const client = new Groq({ apiKey });
  const start = Date.now();
  const response = await client.chat.completions.create(
    {
      model: opts.model,
      max_completion_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: [{ role: 'user', content: opts.prompt }],
    },
    { signal: opts.signal },
  );
  const text = response.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new Error('groq: empty content in response');
  }
  return {
    text,
    provider: 'groq',
    model: response.model ?? opts.model,
    latencyMs: Date.now() - start,
  };
}

export const TEXT_ADAPTERS: Record<
  LLMProvider,
  (opts: TextCallOpts, apiKey: string) => Promise<TextCallResult>
> = {
  anthropic: callAnthropicText,
  openai: callOpenAIText,
  gemini: callGeminiText,
  groq: callGroqText,
};
