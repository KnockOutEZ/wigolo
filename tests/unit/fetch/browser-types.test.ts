import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resetConfig, getConfig } from '../../../src/config.js';
import { parseBrowserTypes } from '../../../src/fetch/browser-types.js';
import type { BrowserType } from '../../../src/types.js';

describe('config -- browserTypes', () => {
  const originalEnv = process.env;
  beforeEach(() => { process.env = { ...originalEnv }; resetConfig(); });
  afterEach(() => { process.env = originalEnv; resetConfig(); });

  it('defaults to ["chromium"]', () => {
    expect(getConfig().browserTypes).toEqual(['chromium']);
  });

  it('reads WIGOLO_BROWSER_TYPES=chromium', () => {
    process.env.WIGOLO_BROWSER_TYPES = 'chromium';
    resetConfig();
    expect(getConfig().browserTypes).toEqual(['chromium']);
  });

  it('reads WIGOLO_BROWSER_TYPES=chromium,firefox', () => {
    process.env.WIGOLO_BROWSER_TYPES = 'chromium,firefox';
    resetConfig();
    expect(getConfig().browserTypes).toEqual(['chromium', 'firefox']);
  });

  it('reads WIGOLO_BROWSER_TYPES=chromium,firefox,webkit', () => {
    process.env.WIGOLO_BROWSER_TYPES = 'chromium,firefox,webkit';
    resetConfig();
    expect(getConfig().browserTypes).toEqual(['chromium', 'firefox', 'webkit']);
  });
});

describe('parseBrowserTypes', () => {
  it('returns ["chromium"] for undefined input', () => {
    expect(parseBrowserTypes(undefined)).toEqual(['chromium']);
  });

  it('returns ["chromium"] for null input', () => {
    expect(parseBrowserTypes(null as unknown as string | undefined)).toEqual(['chromium']);
  });

  it('returns ["chromium"] for empty string', () => {
    expect(parseBrowserTypes('')).toEqual(['chromium']);
  });

  it('returns ["chromium"] for whitespace-only string', () => {
    expect(parseBrowserTypes('   ')).toEqual(['chromium']);
  });

  it('parses single valid type', () => {
    expect(parseBrowserTypes('firefox')).toEqual(['firefox']);
  });

  it('parses comma-separated valid types', () => {
    expect(parseBrowserTypes('chromium,firefox')).toEqual(['chromium', 'firefox']);
  });

  it('parses all three valid types', () => {
    expect(parseBrowserTypes('chromium,firefox,webkit')).toEqual(['chromium', 'firefox', 'webkit']);
  });

  it('trims whitespace around types', () => {
    expect(parseBrowserTypes(' chromium , firefox ')).toEqual(['chromium', 'firefox']);
  });

  it('handles mixed whitespace and tabs', () => {
    expect(parseBrowserTypes('chromium\t,\tfirefox')).toEqual(['chromium', 'firefox']);
  });

  it('filters out invalid types and logs a warning', () => {
    const result = parseBrowserTypes('chromium,netscape,firefox');
    expect(result).toEqual(['chromium', 'firefox']);
  });

  it('falls back to ["chromium"] when all types are invalid', () => {
    const result = parseBrowserTypes('netscape,ie6,opera');
    expect(result).toEqual(['chromium']);
  });

  it('deduplicates repeated types', () => {
    expect(parseBrowserTypes('chromium,chromium,firefox,firefox')).toEqual(['chromium', 'firefox']);
  });

  it('is case-sensitive (uppercase is invalid)', () => {
    const result = parseBrowserTypes('Chromium,Firefox');
    expect(result).toEqual(['chromium']);
  });

  it('handles single invalid type by falling back to chromium', () => {
    const result = parseBrowserTypes('invalid');
    expect(result).toEqual(['chromium']);
  });

  it('preserves ordering of first occurrence', () => {
    expect(parseBrowserTypes('firefox,chromium,webkit')).toEqual(['firefox', 'chromium', 'webkit']);
  });

  it('handles extra commas gracefully', () => {
    expect(parseBrowserTypes(',chromium,,firefox,')).toEqual(['chromium', 'firefox']);
  });

  it('handles very long input strings', () => {
    const longInput = 'chromium,' + 'x'.repeat(10000) + ',firefox';
    expect(parseBrowserTypes(longInput)).toEqual(['chromium', 'firefox']);
  });

  it('handles unicode characters in type names (treated as invalid)', () => {
    const result = parseBrowserTypes('chromium,\u00e9,firefox');
    expect(result).toEqual(['chromium', 'firefox']);
  });
});
