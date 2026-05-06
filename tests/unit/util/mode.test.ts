import { describe, it, expect, vi, beforeEach } from 'vitest';

const { warnSpy } = vi.hoisted(() => ({ warnSpy: vi.fn() }));

vi.mock('../../../src/logger.js', () => ({
  createLogger: () => ({
    warn: warnSpy,
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { resolveMode } from '../../../src/util/mode.js';

beforeEach(() => warnSpy.mockClear());

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
    expect(resolveMode('fast')).toBe('cache');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/fast.*deprecated/));
  });

  it('aliases deprecated "balanced" and "deep" → "default" with warnings', () => {
    expect(resolveMode('balanced')).toBe('default');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/balanced.*deprecated/));
    warnSpy.mockClear();
    expect(resolveMode('deep')).toBe('default');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/deep.*deprecated/));
  });

  it('rejects unknown modes', () => {
    expect(() => resolveMode('turbo')).toThrow(/Invalid mode/);
  });
});
