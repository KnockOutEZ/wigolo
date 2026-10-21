// Free-form text completion adapters per provider. Returns plain text
// (markdown / prose) without a JSON schema constraint — used by research +
// agent synthesis. The JSON-schema adapters in anthropic.ts/openai.ts/etc.
// stay for extract's structured path.
//
// SDKs are imported lazily inside each adapter so module-load is cheap;
// otherwise pulling in all four cloud SDKs at boot adds hundreds of ms to
// MCP server startup (caught by the cold-start e2e timing test).

import type { LLMProvider } from './types.js';

/** Optional image attached to a text call, for vision-capable models. */
export interface TextCallImage {
  /** Base64-encoded image bytes, without a `data:` URI prefix. */
  data: string;
  /** IANA media type, e.g. 'image/png' or 'image/jpeg'. */
  mediaType: string;
}

export interface TextCallOpts {
  prompt: string;
  model: string;
  maxTokens?: number;
  signal?: AbortSignal;
  /**
   * When set, the prompt is sent as a multimodal message with this image.
   * Supported on anthropic/openai/gemini; ignored by groq (text-only).
   */
  image?: TextCallImage;
}

export interface TextCallResult {
  text: string;
  provider: LLMProvider;
  model: string;
  latencyMs: number;
}

const DEFAULT_MAX_TOKENS = 2000;

export async function callAnthropicText(opts: TextCallOpts, apiKey: string): Promise<TextCallResult> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });
  const start = Date.now();
  const content = opts.image
    ? [
        {
          type: 'image' as const,
          source: {
            type: 'base64' as const,
            media_type: opts.image.mediaType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
            data: opts.image.data,
          },
        },
        { type: 'text' as const, text: opts.prompt },
      ]
    : opts.prompt;
  const response = await client.messages.create(
    {
      model: opts.model,
      max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: [{ role: 'user', content }],
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
  const { default: OpenAI } = await import('openai');
  const client = new OpenAI({ apiKey });
  const start = Date.now();
  const content = opts.image
    ? [
        { type: 'text' as const, text: opts.prompt },
        {
          type: 'image_url' as const,
          image_url: { url: `data:${opts.image.mediaType};base64,${opts.image.data}` },
        },
      ]
    : opts.prompt;
  const response = await client.chat.completions.create(
    {
      model: opts.model,
      max_completion_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: [{ role: 'user', content }],
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
  const { GoogleGenAI } = await import('@google/genai');
  const client = new GoogleGenAI({ apiKey });
  const start = Date.now();
  const contents = opts.image
    ? [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType: opts.image.mediaType, data: opts.image.data } },
            { text: opts.prompt },
          ],
        },
      ]
    : opts.prompt;
  const response = await client.models.generateContent({
    model: opts.model,
    contents,
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
  const { default: Groq } = await import('groq-sdk');
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
