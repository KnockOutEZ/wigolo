import { describe, it, expectTypeOf } from 'vitest';
import type {
  LLMProvider,
  LLMExtractResult,
  LLMCallRecord,
  LLMCallOpts,
} from '../../../../src/extraction/llm/types.js';

describe('llm types', () => {
  it('LLMProvider is union of supported providers', () => {
    expectTypeOf<LLMProvider>().toEqualTypeOf<
      'anthropic' | 'openai' | 'gemini' | 'groq'
    >();
  });

  it('LLMExtractResult shape', () => {
    const r: LLMExtractResult = {
      values: { name: 'x' },
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      cached: false,
      latencyMs: 12,
    };
    expectTypeOf(r.values).toEqualTypeOf<Record<string, unknown>>();
    expectTypeOf(r.provider).toEqualTypeOf<LLMProvider>();
    expectTypeOf(r.cached).toEqualTypeOf<boolean>();
    expectTypeOf(r.warnings).toEqualTypeOf<string[] | undefined>();
  });

  it('LLMCallRecord shape', () => {
    const rec: LLMCallRecord = {
      modelId: 'claude-haiku-4-5',
      promptHash: 'a',
      schemaHash: 'b',
      response: '{}',
      createdAt: 0,
      expiresAt: 1,
    };
    expectTypeOf(rec.createdAt).toEqualTypeOf<number>();
    expectTypeOf(rec.expiresAt).toEqualTypeOf<number>();
  });

  it('LLMCallOpts shape', () => {
    const opts: LLMCallOpts = {
      prompt: 'p',
      jsonSchema: { type: 'object' },
    };
    expectTypeOf(opts.modelOverride).toEqualTypeOf<string | undefined>();
    expectTypeOf(opts.signal).toEqualTypeOf<AbortSignal | undefined>();
  });
});
