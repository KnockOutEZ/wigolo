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

function cfg(settings: Record<string, unknown>): PersistedConfig {
  return { version: 1, settings };
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
    expect(hasRequiredFields(cfg({ llmProvider: 'anthropic', llmApiKey: 'sk-xxx' }))).toBe(true);
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

  it('provider is non-string (number) → false', () => {
    expect(hasRequiredFields(cfg({ llmProvider: 42, llmApiKey: 'sk-xxx' }))).toBe(false);
  });

  it('key is non-string (object) → false', () => {
    expect(hasRequiredFields(cfg({ llmProvider: 'anthropic', llmApiKey: {} }))).toBe(false);
  });
});
