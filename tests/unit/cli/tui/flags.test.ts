import { describe, expect, it } from 'vitest';
import {
  parseInitFlags,
  parseSetupMcpFlags,
  FlagParseError,
} from '../../../../src/cli/tui/flags.js';

describe('parseInitFlags — defaults', () => {
  it('returns all-false defaults on empty args', () => {
    const out = parseInitFlags([]);
    expect(out.nonInteractive).toBe(false);
    expect(out.agents).toEqual([]);
    expect(out.skipVerify).toBe(false);
    expect(out.plain).toBe(false);
    expect(out.help).toBe(false);
  });
});

describe('parseInitFlags — flags', () => {
  it('recognizes --non-interactive', () => {
    expect(parseInitFlags(['--non-interactive']).nonInteractive).toBe(true);
  });

  it('recognizes -y as alias for --non-interactive', () => {
    expect(parseInitFlags(['-y']).nonInteractive).toBe(true);
  });

  it('parses --agents=<csv>', () => {
    expect(parseInitFlags(['--agents=claude-code,cursor']).agents).toEqual(['claude-code', 'cursor']);
  });

  it('parses --agents <csv> (space-separated)', () => {
    expect(parseInitFlags(['--agents', 'claude-code,cursor']).agents).toEqual(['claude-code', 'cursor']);
  });

  it('trims whitespace inside --agents', () => {
    expect(parseInitFlags(['--agents=claude-code, cursor , zed']).agents).toEqual(['claude-code', 'cursor', 'zed']);
  });

  it('deduplicates --agents entries preserving first occurrence', () => {
    expect(parseInitFlags(['--agents=cursor,cursor,claude-code,cursor']).agents).toEqual(['cursor', 'claude-code']);
  });

  it('recognizes --skip-verify', () => {
    expect(parseInitFlags(['--skip-verify']).skipVerify).toBe(true);
  });

  it('recognizes --plain', () => {
    expect(parseInitFlags(['--plain']).plain).toBe(true);
  });

  it('recognizes --wizard (rich Ink TUI, not the plain-text prompt mode)', () => {
    const out = parseInitFlags(['--wizard']);
    expect(out.wizard).toBe(true);
    expect(out.interactive).toBe(false);
  });

  it('recognizes --interactive (plain-text prompts) as a mode distinct from --wizard', () => {
    // --interactive is its OWN mode (plain-text prompts), NOT an alias of the
    // Ink wizard — it must set interactive without setting wizard.
    const out = parseInitFlags(['--interactive']);
    expect(out.interactive).toBe(true);
    expect(out.wizard).toBe(false);
  });

  it('accepts --non-interactive as a no-op alongside the default (still parses)', () => {
    // --non-interactive is a documented no-op now (unattended is the default),
    // but it must still be ACCEPTED so published scripts keep working.
    const out = parseInitFlags(['--non-interactive', '--agents=cursor']);
    expect(out.nonInteractive).toBe(true);
    expect(out.agents).toEqual(['cursor']);
  });

  it('recognizes --help and -h', () => {
    expect(parseInitFlags(['--help']).help).toBe(true);
    expect(parseInitFlags(['-h']).help).toBe(true);
  });

  it('combines flags in any order', () => {
    const out = parseInitFlags(['--plain', '--agents=cursor', '-y', '--skip-verify']);
    expect(out).toEqual({
      nonInteractive: true,
      agents: ['cursor'],
      skipVerify: true,
      plain: true,
      help: false,
      interactive: false,
      wizard: false,
      // Full setup is the default: warmup is TRUE unless --no-warmup is passed.
      warmup: true,
      json: false,
      provider: undefined,
      search: undefined,
    });
  });
});

describe('parseInitFlags — errors', () => {
  it('throws FlagParseError on unknown agent id', () => {
    try {
      parseInitFlags(['--agents=cursor,not-a-real-agent']);
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(FlagParseError);
      expect((err as FlagParseError).code).toBe('unknown-agent');
      expect((err as FlagParseError).message).toContain('not-a-real-agent');
    }
  });

  it('throws FlagParseError on empty --agents= value', () => {
    try {
      parseInitFlags(['--agents=']);
      expect.fail('expected throw');
    } catch (err) {
      expect((err as FlagParseError).code).toBe('empty-agents');
    }
  });

  it('throws FlagParseError on --agents with no following argument', () => {
    try {
      parseInitFlags(['--agents']);
      expect.fail('expected throw');
    } catch (err) {
      expect((err as FlagParseError).code).toBe('empty-agents');
    }
  });

  it('throws FlagParseError on unknown flag', () => {
    try {
      parseInitFlags(['--no-such-flag']);
      expect.fail('expected throw');
    } catch (err) {
      expect((err as FlagParseError).code).toBe('unknown-flag');
      expect((err as FlagParseError).message).toContain('--no-such-flag');
    }
  });
});

describe('parseSetupMcpFlags', () => {
  it('accepts a leading "mcp" subcommand positional and treats the rest as flags', () => {
    const out = parseSetupMcpFlags(['mcp', '--non-interactive', '--agents=cursor']);
    expect(out.nonInteractive).toBe(true);
    expect(out.agents).toEqual(['cursor']);
  });

  it('rejects --skip-verify (not a valid setup-mcp flag)', () => {
    try {
      parseSetupMcpFlags(['mcp', '--skip-verify']);
      expect.fail('expected throw');
    } catch (err) {
      expect((err as FlagParseError).code).toBe('unknown-flag');
    }
  });
});
