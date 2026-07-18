import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initDatabase, closeDatabase } from '../../src/cache/db.js';
import { resetConfig } from '../../src/config.js';

const anthropicCreate = vi.fn();
const openaiCreate = vi.fn();
const geminiGenerate = vi.fn();
const groqCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: anthropicCreate };
  },
}));
vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: openaiCreate } };
  },
}));
vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContent: geminiGenerate };
  },
}));
vi.mock('groq-sdk', () => ({
  default: class {
    chat = { completions: { create: groqCreate } };
  },
}));

import { extractWithLLM } from '../../src/extraction/llm-fallback.js';

const schema = {
  type: 'object',
  required: ['price'],
  properties: { price: { type: 'string' } },
};

describe('llm-fallback e2e per provider', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GROQ_API_KEY;
    delete process.env.WIGOLO_LLM_PROVIDER;
    resetConfig();
    initDatabase(':memory:');
    anthropicCreate.mockReset();
    openaiCreate.mockReset();
    geminiGenerate.mockReset();
    groqCreate.mockReset();
  });

  afterEach(() => {
    closeDatabase();
    process.env = originalEnv;
    resetConfig();
  });

  it('anthropic full path with cache hit on second call', async () => {
    process.env.ANTHROPIC_API_KEY = 'k';
    anthropicCreate.mockResolvedValue({
      content: [
        { type: 'tool_use', name: 'extract', input: { price: '$1' } },
      ],
      model: 'claude-haiku-4-5',
    });
    const a = await extractWithLLM({
      html: '<p/>',
      jsonSchema: schema,
      partial: {},
      missing: ['price'],
    });
    expect(a.values).toEqual({ price: '$1' });
    expect(a.cached).toBe(false);

    const t0 = Date.now();
    const b = await extractWithLLM({
      html: '<p/>',
      jsonSchema: schema,
      partial: {},
      missing: ['price'],
    });
    expect(b.cached).toBe(true);
    expect(Date.now() - t0).toBeLessThan(50);
    expect(anthropicCreate).toHaveBeenCalledTimes(1);
  });

  it('openai full path', async () => {
    process.env.OPENAI_API_KEY = 'k';
    openaiCreate.mockResolvedValue({
      choices: [{ message: { content: '{"price":"$2"}' } }],
      model: 'gpt-4o-mini',
    });
    const out = await extractWithLLM({
      html: '<p/>',
      jsonSchema: schema,
      partial: {},
      missing: ['price'],
    });
    expect(out.values).toEqual({ price: '$2' });
    expect(out.provider).toBe('openai');
  });

  it('gemini full path', async () => {
    process.env.GOOGLE_API_KEY = 'k';
    geminiGenerate.mockResolvedValue({ text: '{"price":"$3"}' });
    const out = await extractWithLLM({
      html: '<p/>',
      jsonSchema: schema,
      partial: {},
      missing: ['price'],
    });
    expect(out.values).toEqual({ price: '$3' });
    expect(out.provider).toBe('gemini');
  });

  it('groq full path', async () => {
    process.env.GROQ_API_KEY = 'k';
    groqCreate.mockResolvedValue({
      choices: [{ message: { content: '{"price":"$4"}' } }],
      model: 'llama-3.3-70b-versatile',
    });
    const out = await extractWithLLM({
      html: '<p/>',
      jsonSchema: schema,
      partial: {},
      missing: ['price'],
    });
    expect(out.values).toEqual({ price: '$4' });
    expect(out.provider).toBe('groq');
  });

  it('no-key returns warning listing all four env vars', async () => {
    const out = await extractWithLLM({
      html: '<p/>',
      jsonSchema: schema,
      partial: {},
      missing: ['price'],
    });
    const w = out.warnings.join(' ');
    expect(w).toMatch(/ANTHROPIC_API_KEY/);
    expect(w).toMatch(/OPENAI_API_KEY/);
    expect(w).toMatch(/GEMINI_API_KEY/);
    expect(w).toMatch(/GROQ_API_KEY/);
  });

  it('budget exhaustion blocks call', async () => {
    process.env.ANTHROPIC_API_KEY = 'k';
    const out = await extractWithLLM({
      html: '<p/>',
      jsonSchema: schema,
      partial: {},
      missing: ['price'],
      budget: { remaining: 0 },
    });
    expect(out.warnings.join(' ')).toMatch(/budget|cap/i);
    expect(anthropicCreate).not.toHaveBeenCalled();
  });
});
