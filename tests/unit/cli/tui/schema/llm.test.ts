import { describe, it, expect } from 'vitest';
import { llmCategory } from '../../../../../src/cli/tui/schema/llm.js';

describe('llmCategory', () => {
  it('has id llm with the spec label/description', () => {
    expect(llmCategory.id).toBe('llm');
    expect(llmCategory.label).toBe('LLM Provider');
    expect(llmCategory.description).toMatch(/research\/agent/i);
  });

  it('declares exactly two fields: provider and api key (base URL field removed with custom option)', () => {
    const keys = llmCategory.fields.map((f) => f.settingsPath);
    expect(keys).toEqual(['llmProvider', 'llmApiKey']);
  });

  it('provider is a select offering anthropic, openai, gemini, and the keyless ollama lever', () => {
    const provider = llmCategory.fields.find((f) => f.settingsPath === 'llmProvider');
    expect(provider).toBeDefined();
    expect(provider?.kind).toBe('select');
    expect(provider?.options?.map((o) => o.value)).toEqual([
      'anthropic',
      'openai',
      'gemini',
      'ollama',
    ]);
    expect(provider?.options?.map((o) => o.value)).not.toContain('custom');
    expect(provider?.default).toBe('anthropic');
  });

  it('exposes ollama as a keyless local-LLM choice (no api-key field shown when selected)', () => {
    // WHY: ollama needs no credential — surfacing it as a provider WITHOUT an
    // api-key prompt is the whole point of the lever; a key field would imply
    // a credential the local server ignores and confuse the user.
    const provider = llmCategory.fields.find((f) => f.settingsPath === 'llmProvider');
    const ollama = provider?.options?.find((o) => o.value === 'ollama');
    expect(ollama).toBeDefined();
    expect(ollama?.label).toMatch(/local/i);

    const key = llmCategory.fields.find((f) => f.settingsPath === 'llmApiKey');
    expect(typeof key?.visible).toBe('function');
    // Hidden when ollama is chosen (pending), visible for keyed providers.
    expect(key?.visible?.({ current: {}, pending: { llmProvider: 'ollama' } })).toBe(false);
    expect(key?.visible?.({ current: {}, pending: { llmProvider: 'anthropic' } })).toBe(true);
    // current-layer selection (already persisted) also hides the key field.
    expect(key?.visible?.({ current: { llmProvider: 'ollama' }, pending: {} })).toBe(false);
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

  it('llmBaseUrl field is removed — the custom endpoint URL field no longer exists in the schema', () => {
    // The custom provider option was removed; the conditional Endpoint URL field
    // that was tied to provider === 'custom' is also gone. Users who need a
    // custom backend set WIGOLO_LLM_PROVIDER to the URL directly via env var —
    // that undocumented escape hatch is not surfaced in the schema.
    const url = llmCategory.fields.find((f) => f.settingsPath === 'llmBaseUrl');
    expect(url).toBeUndefined();
  });

  it('every field has a settingsPath, label, and key', () => {
    for (const f of llmCategory.fields) {
      expect(f.settingsPath, `field ${f.key} missing settingsPath`).toBeTruthy();
      expect(f.label, `field ${f.key} missing label`).toBeTruthy();
      expect(f.key, `field ${f.settingsPath} missing key`).toBeTruthy();
    }
  });
});
