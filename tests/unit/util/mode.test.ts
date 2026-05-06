import { describe, it, expect, vi } from 'vitest';
import { resolveMode } from '../../../src/util/mode.js';

describe('resolveMode', () => {
  it('defaults to "default" when value is undefined', () => {
    expect(resolveMode(undefined)).toBe('default');
  });

  it('passes through "cache", "default", "stealth"', () => {
    expect(resolveMode('cache')).toBe('cache');
    expect(resolveMode('default')).toBe('default');
    expect(resolveMode('stealth')).toBe('stealth');
  });

  it('aliases deprecated "fast" → "cache" with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveMode('fast')).toBe('cache');
    warn.mockRestore();
  });

  it('aliases deprecated "balanced" and "deep" → "default"', () => {
    expect(resolveMode('balanced')).toBe('default');
    expect(resolveMode('deep')).toBe('default');
  });

  it('rejects unknown modes', () => {
    expect(() => resolveMode('turbo')).toThrow(/Invalid mode/);
  });
});
