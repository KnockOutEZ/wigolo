import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resetConfig } from '../../../src/config.js';
import { getConfig } from '../../../src/config.js';
import {
  validateExtractor,
  validateSearchEngine,
  validatePluginExports,
} from '../../../src/plugins/validate.js';

describe('config -- pluginsDir', () => {
  const originalEnv = process.env;
  beforeEach(() => { process.env = { ...originalEnv }; resetConfig(); });
  afterEach(() => { process.env = originalEnv; resetConfig(); });

  it('defaults pluginsDir to dataDir/plugins', () => {
    const config = getConfig();
    expect(config.pluginsDir).toContain('plugins');
    expect(config.pluginsDir).toContain('.wigolo');
  });

  it('reads WIGOLO_PLUGINS_DIR from env', () => {
    process.env.WIGOLO_PLUGINS_DIR = '/tmp/my-plugins';
    resetConfig();
    expect(getConfig().pluginsDir).toBe('/tmp/my-plugins');
  });

  it('expands ~ in WIGOLO_PLUGINS_DIR to homedir', () => {
    process.env.WIGOLO_PLUGINS_DIR = '~/custom-plugins';
    resetConfig();
    const dir = getConfig().pluginsDir;
    expect(dir).not.toContain('~');
    expect(dir).toContain('custom-plugins');
  });
});

describe('validateExtractor', () => {
  it('returns true for a valid Extractor shape', () => {
    const valid = {
      name: 'test',
      canHandle: (_url: string) => true,
      extract: (_html: string, _url: string) => null,
    };
    expect(validateExtractor(valid)).toBe(true);
  });

  it('returns false when name is missing', () => {
    const invalid = {
      canHandle: () => true,
      extract: () => null,
    };
    expect(validateExtractor(invalid)).toBe(false);
  });

  it('returns false when name is not a string', () => {
    const invalid = {
      name: 42,
      canHandle: () => true,
      extract: () => null,
    };
    expect(validateExtractor(invalid)).toBe(false);
  });

  it('returns false when canHandle is missing', () => {
    const invalid = {
      name: 'test',
      extract: () => null,
    };
    expect(validateExtractor(invalid)).toBe(false);
  });

  it('returns false when canHandle is not a function', () => {
    const invalid = {
      name: 'test',
      canHandle: 'not-a-function',
      extract: () => null,
    };
    expect(validateExtractor(invalid)).toBe(false);
  });

  it('returns false when extract is missing', () => {
    const invalid = {
      name: 'test',
      canHandle: () => true,
    };
    expect(validateExtractor(invalid)).toBe(false);
  });

  it('returns false when extract is not a function', () => {
    const invalid = {
      name: 'test',
      canHandle: () => true,
      extract: 'not-a-function',
    };
    expect(validateExtractor(invalid)).toBe(false);
  });

  it('returns false for null', () => {
    expect(validateExtractor(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(validateExtractor(undefined)).toBe(false);
  });

  it('returns false for a string', () => {
    expect(validateExtractor('hello')).toBe(false);
  });

  it('returns false for a number', () => {
    expect(validateExtractor(42)).toBe(false);
  });

  it('returns false for an empty object', () => {
    expect(validateExtractor({})).toBe(false);
  });

  it('returns true even with extra properties', () => {
    const valid = {
      name: 'test',
      canHandle: () => true,
      extract: () => null,
      extraProp: 'ignored',
    };
    expect(validateExtractor(valid)).toBe(true);
  });

  it('returns false when name is empty string', () => {
    const invalid = {
      name: '',
      canHandle: () => true,
      extract: () => null,
    };
    expect(validateExtractor(invalid)).toBe(false);
  });
});

describe('validateSearchEngine', () => {
  it('returns true for a valid SearchEngine shape', () => {
    const valid = {
      name: 'test-engine',
      search: async () => [],
    };
    expect(validateSearchEngine(valid)).toBe(true);
  });

  it('returns false when name is missing', () => {
    const invalid = { search: async () => [] };
    expect(validateSearchEngine(invalid)).toBe(false);
  });

  it('returns false when name is not a string', () => {
    const invalid = { name: 123, search: async () => [] };
    expect(validateSearchEngine(invalid)).toBe(false);
  });

  it('returns false when search is missing', () => {
    const invalid = { name: 'test' };
    expect(validateSearchEngine(invalid)).toBe(false);
  });

  it('returns false when search is not a function', () => {
    const invalid = { name: 'test', search: 'not-a-function' };
    expect(validateSearchEngine(invalid)).toBe(false);
  });

  it('returns false for null', () => {
    expect(validateSearchEngine(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(validateSearchEngine(undefined)).toBe(false);
  });

  it('returns false for a string', () => {
    expect(validateSearchEngine('hello')).toBe(false);
  });

  it('returns false for an empty object', () => {
    expect(validateSearchEngine({})).toBe(false);
  });

  it('returns true even with extra properties', () => {
    const valid = {
      name: 'test-engine',
      search: async () => [],
      extraProp: 'ignored',
    };
    expect(validateSearchEngine(valid)).toBe(true);
  });

  it('returns false when name is empty string', () => {
    const invalid = {
      name: '',
      search: async () => [],
    };
    expect(validateSearchEngine(invalid)).toBe(false);
  });
});

describe('validatePluginExports', () => {
  it('returns { hasExtractor: true } for a module with valid extractor only', () => {
    const mod = {
      extractor: { name: 'x', canHandle: () => true, extract: () => null },
    };
    const result = validatePluginExports(mod);
    expect(result.hasExtractor).toBe(true);
    expect(result.hasSearchEngine).toBe(false);
    expect(result.errors).toHaveLength(0);
  });

  it('returns { hasSearchEngine: true } for a module with valid searchEngine only', () => {
    const mod = {
      searchEngine: { name: 'y', search: async () => [] },
    };
    const result = validatePluginExports(mod);
    expect(result.hasExtractor).toBe(false);
    expect(result.hasSearchEngine).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('returns both true for a module with valid extractor and searchEngine', () => {
    const mod = {
      extractor: { name: 'x', canHandle: () => true, extract: () => null },
      searchEngine: { name: 'y', search: async () => [] },
    };
    const result = validatePluginExports(mod);
    expect(result.hasExtractor).toBe(true);
    expect(result.hasSearchEngine).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('returns errors for invalid extractor shape', () => {
    const mod = {
      extractor: { name: 'x' }, // missing canHandle, extract
    };
    const result = validatePluginExports(mod);
    expect(result.hasExtractor).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('extractor');
  });

  it('returns errors for invalid searchEngine shape', () => {
    const mod = {
      searchEngine: { foo: 'bar' }, // missing name, search
    };
    const result = validatePluginExports(mod);
    expect(result.hasSearchEngine).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('searchEngine');
  });

  it('returns neither flag and an error when module exports nothing relevant', () => {
    const mod = { unrelated: 'value' };
    const result = validatePluginExports(mod);
    expect(result.hasExtractor).toBe(false);
    expect(result.hasSearchEngine).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('neither');
  });

  it('handles null module gracefully', () => {
    const result = validatePluginExports(null);
    expect(result.hasExtractor).toBe(false);
    expect(result.hasSearchEngine).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('handles undefined module gracefully', () => {
    const result = validatePluginExports(undefined);
    expect(result.hasExtractor).toBe(false);
    expect(result.hasSearchEngine).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
