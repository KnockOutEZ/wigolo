import { describe, it, expect } from 'vitest';
import { selectProvider } from '../../../../src/extraction/llm/select.js';

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
});
