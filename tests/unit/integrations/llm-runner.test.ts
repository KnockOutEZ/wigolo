import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockCalls: Array<{ provider: string; model: string; prompt: string }> = [];

vi.mock('../../../src/integrations/cloud/llm/text-adapters.js', () => {
  const make = (provider: string) => async (opts: { prompt: string; model: string }) => {
    mockCalls.push({ provider, model: opts.model, prompt: opts.prompt });
    return { text: `reply from ${provider} via ${opts.model}`, provider, model: opts.model, latencyMs: 1 };
  };
  return {
    TEXT_ADAPTERS: {
      anthropic: make('anthropic'),
      openai: make('openai'),
      gemini: make('gemini'),
      groq: make('groq'),
    },
  };
});

const { runLlmText, runLlmJson, isLlmConfigured } = await import(
  '../../../src/integrations/cloud/llm/run.js'
);
const { resolveModel, providerDefaultModel } = await import(
  '../../../src/integrations/cloud/llm/model-select.js'
);

describe('runLlmText', () => {
  const originalEnv = process.env;
  beforeEach(() => {
    mockCalls.length = 0;
    process.env = { ...originalEnv };
    delete process.env.WIGOLO_LLM_PROVIDER;
    delete process.env.WIGOLO_LLM_MODEL;
    delete process.env.WIGOLO_LLM_MODEL_GEMINI;
    delete process.env.WIGOLO_LLM_MODEL_ANTHROPIC;
    delete process.env.WIGOLO_LLM_MODEL_OPENAI;
    delete process.env.WIGOLO_LLM_MODEL_GROQ;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GROQ_API_KEY;
  });
  afterEach(() => {
    process.env = originalEnv;
  });

  it('routes to gemini when WIGOLO_LLM_PROVIDER=gemini + GOOGLE_API_KEY set', async () => {
    process.env.WIGOLO_LLM_PROVIDER = 'gemini';
    process.env.GOOGLE_API_KEY = 'k';
    const r = await runLlmText({ prompt: 'hi' });
    expect(mockCalls).toHaveLength(1);
    expect(mockCalls[0].provider).toBe('gemini');
    expect(r.provider).toBe('gemini');
  });

  it('uses provider-specific model env over universal', async () => {
    process.env.WIGOLO_LLM_PROVIDER = 'gemini';
    process.env.GOOGLE_API_KEY = 'k';
    process.env.WIGOLO_LLM_MODEL = 'universal-fallback';
    process.env.WIGOLO_LLM_MODEL_GEMINI = 'gemini-2.5-pro';
    await runLlmText({ prompt: 'hi' });
    expect(mockCalls[0].model).toBe('gemini-2.5-pro');
  });

  it('uses universal WIGOLO_LLM_MODEL when no provider-specific env', async () => {
    process.env.WIGOLO_LLM_PROVIDER = 'anthropic';
    process.env.ANTHROPIC_API_KEY = 'k';
    process.env.WIGOLO_LLM_MODEL = 'claude-opus-4-7';
    await runLlmText({ prompt: 'hi' });
    expect(mockCalls[0].model).toBe('claude-opus-4-7');
  });

  it('uses provider default when no env override', async () => {
    process.env.WIGOLO_LLM_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'k';
    await runLlmText({ prompt: 'hi' });
    expect(mockCalls[0].model).toBe(providerDefaultModel('openai'));
  });

  it('caller modelOverride wins over all env', async () => {
    process.env.WIGOLO_LLM_PROVIDER = 'groq';
    process.env.GROQ_API_KEY = 'k';
    process.env.WIGOLO_LLM_MODEL = 'env-model';
    process.env.WIGOLO_LLM_MODEL_GROQ = 'groq-env-model';
    await runLlmText({ prompt: 'hi', modelOverride: 'caller-pick' });
    expect(mockCalls[0].model).toBe('caller-pick');
  });

  it('falls back to first provider with a key when WIGOLO_LLM_PROVIDER unset', async () => {
    process.env.OPENAI_API_KEY = 'k';
    await runLlmText({ prompt: 'hi' });
    expect(mockCalls[0].provider).toBe('openai');
  });

  it('throws when no provider configured', async () => {
    await expect(runLlmText({ prompt: 'hi' })).rejects.toThrow(/No LLM configured/);
  });

  it('isLlmConfigured returns false when nothing set', () => {
    expect(isLlmConfigured(process.env)).toBe(false);
  });

  it('isLlmConfigured returns true when API key set', () => {
    process.env.OPENAI_API_KEY = 'k';
    expect(isLlmConfigured(process.env)).toBe(true);
  });

  it('isLlmConfigured returns true when WIGOLO_LLM_PROVIDER is URL', () => {
    process.env.WIGOLO_LLM_PROVIDER = 'http://localhost:11434';
    expect(isLlmConfigured(process.env)).toBe(true);
  });
});

describe('runLlmJson', () => {
  const originalEnv = process.env;
  beforeEach(() => {
    mockCalls.length = 0;
    process.env = { ...originalEnv };
    delete process.env.WIGOLO_LLM_PROVIDER;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GROQ_API_KEY;
  });
  afterEach(() => {
    process.env = originalEnv;
  });

  it('parses JSON from response and returns values', async () => {
    process.env.WIGOLO_LLM_PROVIDER = 'gemini';
    process.env.GOOGLE_API_KEY = 'k';
    vi.doMock('../../../src/integrations/cloud/llm/text-adapters.js', () => ({
      TEXT_ADAPTERS: {
        gemini: async () => ({ text: '{"a": 1, "b": "two"}', provider: 'gemini', model: 'm', latencyMs: 0 }),
      },
    }));
    vi.resetModules();
    const { runLlmJson: fresh } = await import('../../../src/integrations/cloud/llm/run.js');
    const r = await fresh({ prompt: 'extract', jsonSchema: { type: 'object' } });
    expect(r.values).toEqual({ a: 1, b: 'two' });
  });
});

describe('resolveModel', () => {
  it('returns provider default when nothing set', () => {
    expect(resolveModel('anthropic', undefined, {})).toBe('claude-haiku-4-5');
  });

  it('honors universal WIGOLO_LLM_MODEL', () => {
    expect(resolveModel('openai', undefined, { WIGOLO_LLM_MODEL: 'custom' })).toBe('custom');
  });

  it('honors provider-specific env over universal', () => {
    expect(
      resolveModel('gemini', undefined, {
        WIGOLO_LLM_MODEL: 'global',
        WIGOLO_LLM_MODEL_GEMINI: 'gemini-2.5-pro',
      }),
    ).toBe('gemini-2.5-pro');
  });

  it('honors caller override over all env', () => {
    expect(
      resolveModel('groq', 'explicit', {
        WIGOLO_LLM_MODEL: 'env',
        WIGOLO_LLM_MODEL_GROQ: 'env-groq',
      }),
    ).toBe('explicit');
  });
});
