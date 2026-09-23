/**
 * hasRequiredFields — determines whether a persisted config has the minimum
 * fields needed to launch the settings shell without running the wizard.
 *
 * Required fields:
 *   - llmProvider: non-empty string (one of anthropic/openai/gemini/custom)
 *   - llmApiKey: non-empty string (the API key or a masked placeholder)
 *
 * These are the two fields the wizard's LLM step collects. If either is
 * absent the user has not finished setup and we should route them into the
 * wizard rather than dropping them into an unconfigured shell.
 */
import { describe, it, expect } from 'vitest';
import { hasRequiredFields } from '../../../../../src/cli/tui/state/required-fields.js';
import type { PersistedConfig } from '../../../../../src/persisted-config.js';
import type { CategoryDef, FieldDef } from '../../../../../src/cli/tui/schema/types.js';

function cfg(settings: Record<string, unknown>): PersistedConfig {
  return { version: 1, settings };
}

function catalogWith(...fields: FieldDef[]): ReadonlyArray<CategoryDef> {
  return [{ id: 'advanced', label: 'Test', description: 'Test fields', fields }];
}

function requiredField(overrides: Partial<FieldDef> = {}): FieldDef {
  return {
    key: 'TEST_VALUE',
    settingsPath: 'testValue',
    label: 'Test value',
    kind: 'text',
    required: true,
    ...overrides,
  };
}

describe('hasRequiredFields', () => {
  it('empty config → false', () => {
    expect(hasRequiredFields(cfg({}))).toBe(false);
  });

  it('provider set, no key → false', () => {
    expect(hasRequiredFields(cfg({ llmProvider: 'anthropic' }))).toBe(false);
  });

  it('key present, no provider → false', () => {
    expect(hasRequiredFields(cfg({ llmApiKey: 'sk-xxx' }))).toBe(false);
  });

  it('provider + key both set → true', () => {
    expect(hasRequiredFields(cfg({ llmProvider: 'anthropic', llmApiKey: 'test-key' }))).toBe(true);
  });

  it('recognizes a persisted secret-location reference without reading the key', () => {
    expect(hasRequiredFields(cfg({
      llmProvider: 'anthropic',
      llmApiKeyKeyLocation: 'keychain',
    }))).toBe(true);
    expect(hasRequiredFields({
      version: 1,
      settings: { llmProvider: 'openai' },
      provider: { name: 'openai', keyLocation: 'file' },
    })).toBe(true);
  });

  it('rejects a legacy provider reference for a different selected provider', () => {
    expect(hasRequiredFields({
      version: 1,
      settings: { llmProvider: 'openai' },
      provider: { name: 'anthropic', keyLocation: 'keychain' },
    })).toBe(false);
  });

  it('rejects a blank legacy provider key-location reference', () => {
    expect(hasRequiredFields({
      version: 1,
      settings: { llmProvider: 'anthropic' },
      provider: { name: 'anthropic', keyLocation: '   ' as 'keychain' },
    })).toBe(false);
  });

  it('does not use the legacy LLM provider block for unrelated secret fields', () => {
    const catalog = catalogWith(requiredField({
      settingsPath: 'otherSecret',
      kind: 'masked',
      secret: true,
    }));

    expect(hasRequiredFields({
      version: 1,
      settings: {},
      provider: { name: 'anthropic', keyLocation: 'keychain' },
    }, catalog)).toBe(false);
  });

  it('provider is empty string → false', () => {
    expect(hasRequiredFields(cfg({ llmProvider: '', llmApiKey: 'sk-xxx' }))).toBe(false);
  });

  it('key is empty string → false', () => {
    expect(hasRequiredFields(cfg({ llmProvider: 'openai', llmApiKey: '' }))).toBe(false);
  });

  it('accepts any non-empty provider string', () => {
    for (const provider of ['anthropic', 'openai', 'gemini', 'custom']) {
      expect(hasRequiredFields(cfg({ llmProvider: provider, llmApiKey: 'k' }))).toBe(true);
    }
  });

  it('ollama provider with NO key → true (keyless local LLM server)', () => {
    // WHY: ollama needs no credential — requiring an api key would re-route a
    // near-zero-friction ollama user back into the wizard, defeating the lever.
    expect(hasRequiredFields(cfg({ llmProvider: 'ollama' }))).toBe(true);
    expect(hasRequiredFields(cfg({ llmProvider: 'ollama', llmApiKey: '' }))).toBe(true);
  });

  it('cloud provider with no key still → false (key requirement preserved)', () => {
    // WHY: exempting ollama must NOT loosen the key requirement for keyed cloud
    // providers — those are still incomplete without a key.
    expect(hasRequiredFields(cfg({ llmProvider: 'anthropic' }))).toBe(false);
    expect(hasRequiredFields(cfg({ llmProvider: 'openai', llmApiKey: '' }))).toBe(false);
    expect(hasRequiredFields(cfg({ llmProvider: 'gemini' }))).toBe(false);
  });

  it('provider is non-string (number) → false', () => {
    expect(hasRequiredFields(cfg({ llmProvider: 42, llmApiKey: 'sk-xxx' }))).toBe(false);
  });

  it('key is non-string (object) → false', () => {
    expect(hasRequiredFields(cfg({ llmProvider: 'anthropic', llmApiKey: {} }))).toBe(false);
  });

  it('derives required paths from the supplied schema instead of provider names', () => {
    const catalog = catalogWith(requiredField({ settingsPath: 'customRequired' }));

    expect(hasRequiredFields(cfg({}), catalog)).toBe(false);
    expect(hasRequiredFields(cfg({ customRequired: 'configured' }), catalog)).toBe(true);
  });

  it('evaluates conditional required rules against persisted settings', () => {
    const catalog = catalogWith(requiredField({
      required: (ctx) => ctx.current.mode === 'cloud',
    }));

    expect(hasRequiredFields(cfg({ mode: 'local' }), catalog)).toBe(true);
    expect(hasRequiredFields(cfg({ mode: 'cloud' }), catalog)).toBe(false);
    expect(hasRequiredFields(cfg({ mode: 'cloud', testValue: 'configured' }), catalog)).toBe(true);
  });

  it('ignores required fields that are not visible in the active schema context', () => {
    const catalog = catalogWith(requiredField({ visible: () => false }));
    expect(hasRequiredFields(cfg({}), catalog)).toBe(true);
  });

  it('treats empty strings and lists as missing while accepting zero and false', () => {
    const textCatalog = catalogWith(requiredField());
    const listCatalog = catalogWith(requiredField({ kind: 'multiselect' }));
    const numberCatalog = catalogWith(requiredField({ kind: 'number' }));
    const toggleCatalog = catalogWith(requiredField({ kind: 'toggle' }));

    expect(hasRequiredFields(cfg({ testValue: '   ' }), textCatalog)).toBe(false);
    expect(hasRequiredFields(cfg({ testValue: [] }), listCatalog)).toBe(false);
    expect(hasRequiredFields(cfg({ testValue: ['one'] }), listCatalog)).toBe(true);
    expect(hasRequiredFields(cfg({ testValue: 0 }), numberCatalog)).toBe(true);
    expect(hasRequiredFields(cfg({ testValue: false }), toggleCatalog)).toBe(true);
  });
});
