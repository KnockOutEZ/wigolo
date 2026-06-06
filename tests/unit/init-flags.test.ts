import { describe, it, expect } from 'vitest';
import { parseInitFlags, parseSetupMcpFlags } from '../../src/cli/tui/flags.js';
import { FlagParseError } from '../../src/cli/tui/flags-types.js';

describe('parseInitFlags provider/search', () => {
  it('parses --provider and --search', () => {
    const f = parseInitFlags(['--provider=openai', '--search=hybrid']);
    expect(f.provider).toBe('openai');
    expect(f.search).toBe('hybrid');
  });

  it('rejects unknown provider', () => {
    expect(() => parseInitFlags(['--provider=bogus'])).toThrow(FlagParseError);
  });

  it('rejects unknown search backend', () => {
    expect(() => parseInitFlags(['--search=bogus'])).toThrow(FlagParseError);
  });

  it('provider/search optional (absent → undefined)', () => {
    const f = parseInitFlags(['--agents=claude-code']);
    expect(f.provider).toBeUndefined();
    expect(f.search).toBeUndefined();
  });

  it('rejects unknown provider with FlagParseError code unknown-provider', () => {
    try {
      parseInitFlags(['--provider=bogus']);
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(FlagParseError);
      expect((e as FlagParseError).code).toBe('unknown-provider');
    }
  });

  it('rejects unknown search with FlagParseError code unknown-search', () => {
    try {
      parseInitFlags(['--search=bogus']);
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(FlagParseError);
      expect((e as FlagParseError).code).toBe('unknown-search');
    }
  });

  it('valid provider values are accepted', () => {
    expect(parseInitFlags(['--provider=anthropic']).provider).toBe('anthropic');
    expect(parseInitFlags(['--provider=openai']).provider).toBe('openai');
    expect(parseInitFlags(['--provider=gemini']).provider).toBe('gemini');
  });

  it('valid search values are accepted', () => {
    expect(parseInitFlags(['--search=core']).search).toBe('core');
    expect(parseInitFlags(['--search=searxng']).search).toBe('searxng');
    expect(parseInitFlags(['--search=hybrid']).search).toBe('hybrid');
  });

  it('space form rejects a following flag as the value', () => {
    expect(() => parseInitFlags(['--provider', '--search=core'])).toThrow(FlagParseError);
  });
});

describe('parseSetupMcpFlags rejects init-only flags', () => {
  it('--provider=openai is rejected by parseSetupMcpFlags (init-only)', () => {
    expect(() => parseSetupMcpFlags(['--provider=openai'])).toThrow(FlagParseError);
  });

  it('--search=core is rejected by parseSetupMcpFlags (init-only)', () => {
    expect(() => parseSetupMcpFlags(['--search=core'])).toThrow(FlagParseError);
  });
});
