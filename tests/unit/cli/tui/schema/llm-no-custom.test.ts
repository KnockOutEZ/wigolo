/**
 * Fix D regression test: the `custom` option must be removed from the LLM
 * provider field. The custom URL escape hatch works via setting WIGOLO_LLM_PROVIDER
 * env var to a URL directly — the schema option only confused users who expected
 * an "endpoint URL" field that the schema couldn't actually fulfil.
 *
 * After Fix D:
 *   - Provider options exclude 'custom' (slice-3 later added the keyless 'ollama' lever).
 *   - The llmBaseUrl conditional field (visible when provider === 'custom') is removed.
 *   - Exactly 2 fields remain: llmProvider + llmApiKey.
 */
import { describe, it, expect } from 'vitest';
import { llmCategory } from '../../../../../src/cli/tui/schema/llm.js';

describe('llmCategory — no custom provider (Fix D)', () => {
  it('provider options exclude the dead custom escape hatch', () => {
    const provider = llmCategory.fields.find((f) => f.settingsPath === 'llmProvider');
    const values = provider?.options?.map((o) => o.value) ?? [];
    expect(values).not.toContain('custom');
    // The keyed cloud providers remain; slice-3 appended the keyless 'ollama' lever.
    expect(values).toEqual(['anthropic', 'openai', 'gemini', 'ollama']);
  });

  it('llmCategory has exactly 2 fields after removing custom + endpoint URL field', () => {
    const paths = llmCategory.fields.map((f) => f.settingsPath);
    expect(paths).toEqual(['llmProvider', 'llmApiKey']);
    expect(paths).not.toContain('llmBaseUrl');
  });

  it('no field is conditionally revealed by provider === custom (the dead llmBaseUrl field is gone)', () => {
    // The only conditional `visible` predicate now keys on ollama (hide the
    // api-key field), never on custom. Selecting custom must not REVEAL any
    // field that is otherwise hidden — i.e. custom yields the same visibility
    // set as a plain keyed provider. We assert this against anthropic as the
    // baseline keyed provider.
    for (const field of llmCategory.fields) {
      if (typeof field.visible === 'function') {
        const visibleForCustom = field.visible({ current: { llmProvider: 'custom' }, pending: {} });
        const visibleForKeyed = field.visible({ current: { llmProvider: 'anthropic' }, pending: {} });
        expect(visibleForCustom).toBe(visibleForKeyed);
      }
    }
  });
});
