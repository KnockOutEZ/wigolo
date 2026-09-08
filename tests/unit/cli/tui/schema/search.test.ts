import { describe, it, expect } from 'vitest';
import { searchCategory } from '../../../../../src/cli/tui/schema/search.js';
import { configKeyBySettingsKey } from '../../../../../src/config.js';

/** The registry is the only place a default or an env-var name is declared. */
function registered(settingsKey: string) {
  const def = configKeyBySettingsKey(settingsKey);
  expect(def, `${settingsKey} missing from CONFIG_KEYS`).toBeDefined();
  return def!;
}

describe('searchCategory', () => {
  it('has id search and the five expected fields', () => {
    expect(searchCategory.id).toBe('search');
    expect(searchCategory.fields.length).toBe(5);
    expect(searchCategory.fields.map((f) => f.settingsPath)).toEqual([
      'searchBackend',
      'newTabSearchEngine',
      'reranker',
      'rerankerModel',
      'embeddingModel',
    ]);
    // The printed identifier is the registry's, never a locally written name.
    for (const f of searchCategory.fields) {
      expect(f.key).toBe(registered(f.settingsPath).envVar ?? f.settingsPath);
    }
  });

  it('offers a validated, local-only new-tab search engine field', () => {
    const f = searchCategory.fields.find((x) => x.settingsPath === 'newTabSearchEngine');
    expect(f?.kind).toBe('text');
    expect(f?.default).toBe(registered('newTabSearchEngine').default);
    expect(f?.propagateToAgents).toBe(false);
    expect(f?.validate?.('wigolo')).toBeNull();
    expect(f?.validate?.('https://search.example.test/?q={searchTerms}')).toBeNull();
    expect(f?.validate?.('http://search.example.test/?q={searchTerms}')).toContain('HTTPS');
    expect(f?.validate?.('https://search.example.test/')).toContain('{searchTerms}');
  });

  it('backend offers the three registered values and shows what unset means', () => {
    const f = searchCategory.fields.find((x) => x.settingsPath === 'searchBackend');
    expect(f?.kind).toBe('select');
    expect(f?.options?.map((o) => o.value)).toEqual(['core', 'searxng', 'hybrid']);
    // Unset resolves to null and every consumer reads null as core, so the
    // field carries the resolver's value plus copy that says what it means.
    expect(f?.default).toBe(registered('searchBackend').default);
    expect(f?.defaultDisplay).toMatch(/core/);
  });

  it('reranker is a picker over its three resolved values, not an on/off switch', () => {
    // WHY: the resolver reads 'onnx' | 'none' | 'custom' and drops a
    // non-string persisted value outright, so the shipped toggle wrote
    // `reranker: false` and the reranker stayed on. A boolean here can never
    // take effect.
    const f = searchCategory.fields.find((x) => x.settingsPath === 'reranker');
    expect(f?.kind).toBe('select');
    expect(f?.options?.map((o) => o.value)).toEqual(['onnx', 'none', 'custom']);
    expect(f?.default).toBe(registered('reranker').default);
    expect(typeof f?.default).toBe('string');
  });

  it('reranker and embedding model defaults come from the registry', () => {
    const rerank = searchCategory.fields.find((x) => x.settingsPath === 'rerankerModel');
    expect(rerank?.kind).toBe('text');
    expect(rerank?.default).toBe(registered('rerankerModel').default);

    const embed = searchCategory.fields.find((x) => x.settingsPath === 'embeddingModel');
    expect(embed?.kind).toBe('text');
    expect(embed?.default).toBe(registered('embeddingModel').default);
  });

  it('names no reranker or embedding library in user-facing copy', () => {
    for (const f of searchCategory.fields) {
      expect(f.help ?? '').not.toMatch(/flashrank|sentence-transformers|searxng/i);
    }
  });

  it('every field has settingsPath + label', () => {
    for (const f of searchCategory.fields) {
      expect(f.settingsPath, `field ${f.key} missing settingsPath`).toBeTruthy();
      expect(f.label, `field ${f.key} missing label`).toBeTruthy();
    }
  });
});
