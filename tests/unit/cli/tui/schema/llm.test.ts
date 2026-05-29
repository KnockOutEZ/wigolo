import { describe, it, expect } from 'vitest';
import { llmCategory } from '../../../../../src/cli/tui/schema/llm.js';

describe('llmCategory', () => {
  it('has id llm with the spec label/description', () => {
    expect(llmCategory.id).toBe('llm');
    expect(llmCategory.label).toBe('LLM Provider');
    expect(llmCategory.description).toMatch(/research\/agent/i);
  });

  it('declares exactly three fields: provider, api key, custom base URL', () => {
    const keys = llmCategory.fields.map((f) => f.settingsPath);
    expect(keys).toEqual(['llmProvider', 'llmApiKey', 'llmBaseUrl']);
  });

  it('provider is a select with the four expected options', () => {
    const provider = llmCategory.fields.find((f) => f.settingsPath === 'llmProvider');
    expect(provider).toBeDefined();
    expect(provider?.kind).toBe('select');
    expect(provider?.options?.map((o) => o.value)).toEqual([
      'anthropic',
      'openai',
      'gemini',
      'custom',
    ]);
    expect(provider?.default).toBe('anthropic');
  });

  it('api key is masked + secret + propagates to agents', () => {
    const key = llmCategory.fields.find((f) => f.settingsPath === 'llmApiKey');
    expect(key).toBeDefined();
    expect(key?.kind).toBe('masked');
    expect(key?.secret).toBe(true);
    expect(key?.propagateToAgents).toBe(true);
    expect(key?.key).toBe('WIGOLO_LLM_API_KEY');
    // Help text must mention the keychain so users understand where secrets land.
    expect(key?.help).toMatch(/keychain/i);
  });

  it('base URL is a text field with a visible predicate', () => {
    const url = llmCategory.fields.find((f) => f.settingsPath === 'llmBaseUrl');
    expect(url).toBeDefined();
    expect(url?.kind).toBe('text');
    expect(typeof url?.visible).toBe('function');
  });

  it('base URL visible() returns false when provider is anthropic', () => {
    const url = llmCategory.fields.find((f) => f.settingsPath === 'llmBaseUrl');
    expect(url?.visible?.({ current: { llmProvider: 'anthropic' }, pending: {} })).toBe(false);
  });

  it('base URL visible() returns true when pending provider is custom', () => {
    const url = llmCategory.fields.find((f) => f.settingsPath === 'llmBaseUrl');
    expect(
      url?.visible?.({ current: { llmProvider: 'anthropic' }, pending: { llmProvider: 'custom' } }),
    ).toBe(true);
  });

  it('base URL visible() returns true when current provider is custom and pending unchanged', () => {
    const url = llmCategory.fields.find((f) => f.settingsPath === 'llmBaseUrl');
    expect(url?.visible?.({ current: { llmProvider: 'custom' }, pending: {} })).toBe(true);
  });

  it('every field has a settingsPath, label, and key', () => {
    for (const f of llmCategory.fields) {
      expect(f.settingsPath, `field ${f.key} missing settingsPath`).toBeTruthy();
      expect(f.label, `field ${f.key} missing label`).toBeTruthy();
      expect(f.key, `field ${f.settingsPath} missing key`).toBeTruthy();
    }
  });
});
