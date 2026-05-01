import Groq from 'groq-sdk';
import type { LLMCallOpts, LLMExtractResult } from './types.js';
import { validateAgainstSchema, type ValidationError } from './validate.js';

const DEFAULT_MODEL = 'llama-3.3-70b-versatile';

export async function callGroq(
  opts: LLMCallOpts,
  apiKey: string,
): Promise<LLMExtractResult> {
  const client = new Groq({ apiKey });
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

  // Retry once with validation errors fed back to the model.
  messages.push({ role: 'assistant', content: first.raw });
  messages.push({ role: 'user', content: retryPrompt(errors) });

  const second = await runOnce(client, model, messages, opts.signal);
  errors = validateAgainstSchema(second.values, opts.jsonSchema);
  if (errors.length > 0) {
    throw new Error(
      `groq: response failed schema validation after retry: ${formatErrors(errors)}`,
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
  client: Groq,
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
    throw new Error('groq: empty content in response');
  }
  let values: Record<string, unknown>;
  try {
    values = JSON.parse(content);
  } catch (e) {
    throw new Error(`groq: invalid JSON in response: ${(e as Error).message}`);
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
    provider: 'groq',
    model,
    cached: false,
    latencyMs: Date.now() - start,
  };
}
