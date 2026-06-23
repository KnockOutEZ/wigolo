import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { initDatabase, closeDatabase } from '../../../src/cache/db.js';
import { resetConfig } from '../../../src/config.js';
import { scrubProviderEnv, emptyKeystoreDataDir } from '../../helpers/provider-isolation.js';

// D11: neutralize the KEYCHAIN leg of provider detection (a real dev-keychain key defeats the no-provider
// assert). ENV + FILE legs neutralized in beforeEach (scrub + empty keystore dataDir).
vi.mock('../../../src/security/keychain.js', () => ({
  keychainAvailable: () => false,
  keychainGet: () => null,
  keychainSet: () => {},
  keychainDelete: () => {},
  WIGOLO_SERVICE: 'wigolo',
}));

vi.mock('../../../src/integrations/cloud/llm/anthropic.js', () => ({
  callAnthropic: vi.fn(),
}));
vi.mock('../../../src/integrations/cloud/llm/openai.js', () => ({
  callOpenAI: vi.fn(),
}));
vi.mock('../../../src/integrations/cloud/llm/gemini.js', () => ({
  callGemini: vi.fn(),
}));
vi.mock('../../../src/integrations/cloud/llm/groq.js', () => ({
  callGroq: vi.fn(),
}));

import { extractWithLLM } from '../../../src/extraction/llm-fallback.js';
import { callAnthropic } from '../../../src/integrations/cloud/llm/anthropic.js';
import { callOpenAI } from '../../../src/integrations/cloud/llm/openai.js';

const schema = {
  type: 'object',
  required: ['price'],
  properties: { price: { type: 'string' } },
};

describe('extractWithLLM', () => {
  const originalEnv = process.env;
  let d11dir: string;

  beforeEach(() => {
    process.env = { ...originalEnv };
    scrubProviderEnv(); // ENV leg: 4 provider keys + WIGOLO_LLM_API_KEY + WIGOLO_LLM_PROVIDER
    d11dir = emptyKeystoreDataDir(); // FILE leg absent-by-construction
    resetConfig();
    initDatabase(':memory:');
    vi.mocked(callAnthropic).mockReset();
    vi.mocked(callOpenAI).mockReset();
  });

  afterEach(() => {
    closeDatabase();
    process.env = originalEnv;
    rmSync(d11dir, { recursive: true, force: true });
    resetConfig();
  });

  it('empty missing returns partial unchanged with no warnings', async () => {
    const out = await extractWithLLM({
      html: '<p/>',
      jsonSchema: schema,
      partial: { price: '$1' },
      missing: [],
    });
    expect(out.values).toEqual({ price: '$1' });
    expect(out.warnings).toEqual([]);
    expect(out.cached).toBe(false);
    expect(callAnthropic).not.toHaveBeenCalled();
  });

  it('no provider → returns partial + actionable warning', async () => {
    const out = await extractWithLLM({
      html: '<p>x</p>',
      jsonSchema: schema,
      partial: {},
      missing: ['price'],
    });
    expect(out.values).toEqual({});
    expect(out.warnings.join(' ')).toMatch(/ANTHROPIC_API_KEY/);
    expect(out.warnings.join(' ')).toMatch(/OPENAI_API_KEY/);
    expect(out.provider).toBe('anthropic');
  });

  it('cache miss → call provider → cache hit on second invocation', async () => {
    process.env.ANTHROPIC_API_KEY = 'k';
    vi.mocked(callAnthropic).mockResolvedValue({
      values: { price: '$10' },
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      cached: false,
      latencyMs: 5,
    });
    const first = await extractWithLLM({
      html: '<p>x</p>',
      jsonSchema: schema,
      partial: {},
      missing: ['price'],
    });
    expect(first.values).toEqual({ price: '$10' });
    expect(first.cached).toBe(false);

    const second = await extractWithLLM({
      html: '<p>x</p>',
      jsonSchema: schema,
      partial: {},
      missing: ['price'],
    });
    expect(second.values).toEqual({ price: '$10' });
    expect(second.cached).toBe(true);
    expect(callAnthropic).toHaveBeenCalledTimes(1);
  });

  it('only fills missing keys, never overrides existing partial values', async () => {
    process.env.ANTHROPIC_API_KEY = 'k';
    vi.mocked(callAnthropic).mockResolvedValue({
      values: { price: '$99', name: 'override-attempt' },
      provider: 'anthropic',
      model: 'm',
      cached: false,
      latencyMs: 1,
    });
    const out = await extractWithLLM({
      html: '<p/>',
      jsonSchema: {
        type: 'object',
        properties: { price: { type: 'string' }, name: { type: 'string' } },
      },
      partial: { name: 'kept' },
      missing: ['price'],
    });
    expect(out.values).toEqual({ name: 'kept', price: '$99' });
  });

  it('budget exhaustion returns warning without calling provider', async () => {
    process.env.ANTHROPIC_API_KEY = 'k';
    const out = await extractWithLLM({
      html: '<p/>',
      jsonSchema: schema,
      partial: {},
      missing: ['price'],
      budget: { remaining: 0 },
    });
    expect(out.warnings.join(' ')).toMatch(/budget|cap/i);
    expect(callAnthropic).not.toHaveBeenCalled();
  });

  it('decrements budget on a successful call', async () => {
    process.env.ANTHROPIC_API_KEY = 'k';
    vi.mocked(callAnthropic).mockResolvedValue({
      values: { price: '$1' },
      provider: 'anthropic',
      model: 'm',
      cached: false,
      latencyMs: 1,
    });
    const budget = { remaining: 1 };
    await extractWithLLM({
      html: '<p/>',
      jsonSchema: schema,
      partial: {},
      missing: ['price'],
      budget,
    });
    expect(budget.remaining).toBe(0);
  });

  it('validation failure surfaces warning and returns partial', async () => {
    process.env.ANTHROPIC_API_KEY = 'k';
    vi.mocked(callAnthropic).mockResolvedValue({
      values: { price: 42 } as unknown as Record<string, unknown>,
      provider: 'anthropic',
      model: 'm',
      cached: false,
      latencyMs: 1,
    });
    const out = await extractWithLLM({
      html: '<p/>',
      jsonSchema: schema,
      partial: {},
      missing: ['price'],
    });
    expect(out.values).toEqual({});
    expect(out.warnings.join(' ')).toMatch(/schema|validation/i);
  });

  it('WIGOLO_LLM_PROVIDER=openai routes to openai', async () => {
    process.env.ANTHROPIC_API_KEY = 'a';
    process.env.OPENAI_API_KEY = 'b';
    process.env.WIGOLO_LLM_PROVIDER = 'openai';
    vi.mocked(callOpenAI).mockResolvedValue({
      values: { price: '$5' },
      provider: 'openai',
      model: 'm',
      cached: false,
      latencyMs: 1,
    });
    const out = await extractWithLLM({
      html: '<p/>',
      jsonSchema: schema,
      partial: {},
      missing: ['price'],
    });
    expect(out.provider).toBe('openai');
    expect(callAnthropic).not.toHaveBeenCalled();
    expect(callOpenAI).toHaveBeenCalledTimes(1);
  });

  it('truncates HTML body in prompt to ≤ 50KB', async () => {
    process.env.ANTHROPIC_API_KEY = 'k';
    vi.mocked(callAnthropic).mockResolvedValue({
      values: { price: '$1' },
      provider: 'anthropic',
      model: 'm',
      cached: false,
      latencyMs: 1,
    });
    const huge = 'a'.repeat(80_000);
    await extractWithLLM({
      html: huge,
      jsonSchema: schema,
      partial: {},
      missing: ['price'],
    });
    const promptArg = vi.mocked(callAnthropic).mock.calls[0][0].prompt;
    expect(promptArg.length).toBeLessThanOrEqual(60_000);
  });
});
