import { describe, it, expect } from 'vitest';
import { cacheCategory } from '../../../../../src/cli/tui/schema/cache.js';
import { configKeyBySettingsKey } from '../../../../../src/config.js';

/** The registry is the only place a default or an env-var name is declared. */
function registered(settingsKey: string) {
  const def = configKeyBySettingsKey(settingsKey);
  expect(def, `${settingsKey} missing from CONFIG_KEYS`).toBeDefined();
  return def!;
}


describe('cacheCategory', () => {
  it('has id cache and three fields', () => {
    expect(cacheCategory.id).toBe('cache');
    expect(cacheCategory.fields.length).toBe(3);
    expect(cacheCategory.fields.map((f) => f.settingsPath)).toEqual([
      'dataDir',
      'cacheTtlSearch',
      'cacheTtlContent',
    ]);
    // The TTL keys were printed as WIGOLO_CACHE_TTL_* — names no resolver
    // reads. The identifier now comes from the registry.
    expect(cacheCategory.fields.map((f) => f.key)).toEqual([
      'WIGOLO_DATA_DIR',
      'CACHE_TTL_SEARCH',
      'CACHE_TTL_CONTENT',
    ]);
    for (const f of cacheCategory.fields) {
      expect(f.key).toBe(registered(f.settingsPath).envVar ?? f.settingsPath);
    }
  });

  it('WIGOLO_DATA_DIR is a path field that explicitly does NOT propagate to agents', () => {
    const f = cacheCategory.fields.find((x) => x.settingsPath === 'dataDir');
    expect(f?.kind).toBe('path');
    expect(f?.propagateToAgents).toBe(false);
  });

  it('search TTL takes its default from the registry, within min 60 / max 604800', () => {
    const f = cacheCategory.fields.find((x) => x.settingsPath === 'cacheTtlSearch');
    expect(f?.kind).toBe('number');
    expect(f?.default).toBe(registered('cacheTtlSearch').default);
    expect(f?.min).toBe(60);
    expect(f?.max).toBe(604800);
    // A default outside the field's own bounds would be unreachable by the editor.
    expect(f!.default as number).toBeGreaterThanOrEqual(f!.min!);
    expect(f!.default as number).toBeLessThanOrEqual(f!.max!);
  });

  it('content TTL takes its default from the registry, within min 60 / max 2592000', () => {
    const f = cacheCategory.fields.find((x) => x.settingsPath === 'cacheTtlContent');
    expect(f?.kind).toBe('number');
    expect(f?.default).toBe(registered('cacheTtlContent').default);
    expect(f?.min).toBe(60);
    expect(f?.max).toBe(2592000);
    expect(f!.default as number).toBeGreaterThanOrEqual(f!.min!);
    expect(f!.default as number).toBeLessThanOrEqual(f!.max!);
  });

  it('every field has settingsPath + label', () => {
    for (const f of cacheCategory.fields) {
      expect(f.settingsPath, `field ${f.key} missing settingsPath`).toBeTruthy();
      expect(f.label, `field ${f.key} missing label`).toBeTruthy();
    }
  });
});
