import { describe, it, expect } from 'vitest';
import { selectProvider, providerKeyFromEnv } from '../../../../src/integrations/cloud/llm/select.js';

describe('selectProvider', () => {
  it('returns null when no keys set', () => {
    expect(selectProvider({})).toBeNull();
  });

  it('prefers anthropic when ANTHROPIC_API_KEY set', () => {
    expect(
      selectProvider({ ANTHROPIC_API_KEY: 'x', OPENAI_API_KEY: 'y' }),
    ).toBe('anthropic');
  });

  it('falls through to openai → gemini → groq', () => {
    expect(selectProvider({ OPENAI_API_KEY: 'x' })).toBe('openai');
    expect(selectProvider({ GOOGLE_API_KEY: 'x' })).toBe('gemini');
    expect(selectProvider({ GROQ_API_KEY: 'x' })).toBe('groq');
  });

  it('WIGOLO_LLM_PROVIDER override forces a specific provider', () => {
    expect(
      selectProvider({
        ANTHROPIC_API_KEY: 'a',
        OPENAI_API_KEY: 'b',
        WIGOLO_LLM_PROVIDER: 'openai',
      }),
    ).toBe('openai');
  });

  it('override ignored when its key is missing', () => {
    expect(
      selectProvider({
        ANTHROPIC_API_KEY: 'a',
        WIGOLO_LLM_PROVIDER: 'groq',
      }),
    ).toBe('anthropic');
  });

  it('unknown override ignored', () => {
    expect(
      selectProvider({
        ANTHROPIC_API_KEY: 'a',
        WIGOLO_LLM_PROVIDER: 'bogus',
      }),
    ).toBe('anthropic');
  });

  it('WIGOLO_LLM_API_KEY satisfies an explicit provider (#102)', () => {
    expect(
      selectProvider({
        WIGOLO_LLM_PROVIDER: 'gemini',
        WIGOLO_LLM_API_KEY: 'x',
      }),
    ).toBe('gemini');
  });

  it('WIGOLO_LLM_API_KEY is ignored without an explicit provider', () => {
    expect(selectProvider({ WIGOLO_LLM_API_KEY: 'x' })).toBeNull();
  });

  it('provider-specific var wins over WIGOLO_LLM_API_KEY', () => {
    expect(
      selectProvider({
        WIGOLO_LLM_PROVIDER: 'gemini',
        GOOGLE_API_KEY: 'g',
        WIGOLO_LLM_API_KEY: 'x',
      }),
    ).toBe('gemini');
  });

  it('accepts GEMINI_API_KEY as an alias for the gemini key (auto-detect)', () => {
    expect(selectProvider({ GEMINI_API_KEY: 'x' })).toBe('gemini');
  });

  it('accepts GEMINI_API_KEY with an explicit gemini provider', () => {
    expect(
      selectProvider({ WIGOLO_LLM_PROVIDER: 'gemini', GEMINI_API_KEY: 'x' }),
    ).toBe('gemini');
  });
});

describe('providerKeyFromEnv', () => {
  it('reads the canonical var per provider', () => {
    expect(providerKeyFromEnv('anthropic', { ANTHROPIC_API_KEY: 'a' })).toBe('a');
    expect(providerKeyFromEnv('gemini', { GOOGLE_API_KEY: 'g' })).toBe('g');
  });

  it('accepts GEMINI_API_KEY as an alias for gemini', () => {
    expect(providerKeyFromEnv('gemini', { GEMINI_API_KEY: 'k' })).toBe('k');
  });

  it('canonical GOOGLE_API_KEY wins over the GEMINI_API_KEY alias', () => {
    expect(
      providerKeyFromEnv('gemini', { GOOGLE_API_KEY: 'g', GEMINI_API_KEY: 'k' }),
    ).toBe('g');
  });

  it('the alias is gemini-only — GEMINI_API_KEY does not satisfy other providers', () => {
    expect(providerKeyFromEnv('openai', { GEMINI_API_KEY: 'k' })).toBeUndefined();
  });
});
