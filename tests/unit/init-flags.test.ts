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

  it('accepts the keyless ollama provider', () => {
    // WHY: ollama is a first-class keyless lever surfaced in the TUI — the
    // non-interactive `--provider=ollama` flag must NOT be rejected as unknown,
    // or scripted setups can't select the local LLM server.
    expect(parseInitFlags(['--provider=ollama']).provider).toBe('ollama');
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

describe('parseInitFlags --wizard / --warmup / --json (headless-first)', () => {
  it('--wizard is parsed (opts into the Ink wizard)', () => {
    // WHY: headless-first — Ink now mounts ONLY under an explicit --wizard flag.
    // The parser must recognise it, or the flip is unreachable.
    expect(parseInitFlags(['--wizard']).wizard).toBe(true);
  });

  it('wizard defaults to false when absent', () => {
    expect(parseInitFlags(['--non-interactive', '--agents=cursor']).wizard).toBe(false);
  });

  it('--warmup is parsed (explicit-on alias, back-compat no-op)', () => {
    // WHY: full setup is now the default; --warmup stays accepted as an
    // explicit-on alias so existing scripts/docs that pass it keep working.
    expect(parseInitFlags(['--warmup']).warmup).toBe(true);
  });

  it('warmup defaults to TRUE when absent (full setup is the default)', () => {
    // WHY: a manual init is a complete, diagnosable setup — it downloads every
    // component so setup failures surface loudly. The inversion of the old
    // opt-in behaviour is load-bearing; this test fails if the default flips.
    expect(parseInitFlags(['--non-interactive', '--agents=cursor']).warmup).toBe(true);
  });

  it('--no-warmup sets warmup false (download-nothing escape hatch)', () => {
    // WHY: --no-warmup is the only way to skip ALL downloads; components then
    // lazy-load on first use. This is the key correctness lever tested live.
    expect(parseInitFlags(['--no-warmup']).warmup).toBe(false);
    expect(parseInitFlags(['--non-interactive', '--agents=cursor', '--no-warmup']).warmup).toBe(false);
  });

  it('--json is parsed (machine-readable summary)', () => {
    expect(parseInitFlags(['--json']).json).toBe(true);
  });

  it('json defaults to false when absent', () => {
    expect(parseInitFlags(['--non-interactive', '--agents=cursor']).json).toBe(false);
  });

  it('--wizard and --warmup and --json combine without error', () => {
    const f = parseInitFlags(['--wizard', '--warmup', '--json']);
    expect(f.wizard).toBe(true);
    expect(f.warmup).toBe(true);
    expect(f.json).toBe(true);
  });
});

describe('parseSetupMcpFlags --json', () => {
  it('--json is parsed for setup mcp', () => {
    expect(parseSetupMcpFlags(['--json']).json).toBe(true);
  });

  it('json defaults to false when absent', () => {
    expect(parseSetupMcpFlags(['--non-interactive', '--agents=cursor']).json).toBe(false);
  });

  it('setup mcp still rejects init-only --wizard/--warmup (init-only flags)', () => {
    // WHY: --wizard/--warmup are init-specific; setup mcp has no wizard/warmup step.
    expect(() => parseSetupMcpFlags(['--wizard'])).toThrow(FlagParseError);
    expect(() => parseSetupMcpFlags(['--warmup'])).toThrow(FlagParseError);
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
