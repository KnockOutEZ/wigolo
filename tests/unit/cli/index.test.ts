import { describe, it, expect } from 'vitest';
import { parseCommand } from '../../../src/cli/index.js';

describe('parseCommand', () => {
  it('returns "mcp" for no arguments', () => {
    expect(parseCommand([])).toEqual({ command: 'mcp', args: [] });
  });

  it('returns "warmup" for warmup argument', () => {
    expect(parseCommand(['warmup'])).toEqual({ command: 'warmup', args: [] });
  });

  it('returns "serve" for serve argument', () => {
    expect(parseCommand(['serve'])).toEqual({ command: 'serve', args: [] });
  });

  it('returns "serve" with port flag', () => {
    expect(parseCommand(['serve', '--port', '4000'])).toEqual({
      command: 'serve',
      args: ['--port', '4000'],
    });
  });

  it('returns "health" for health argument', () => {
    expect(parseCommand(['health'])).toEqual({ command: 'health', args: [] });
  });

  it('treats unknown commands as mcp mode', () => {
    expect(parseCommand(['unknown'])).toEqual({ command: 'mcp', args: [] });
  });

  it('returns "shell" for shell argument', () => {
    expect(parseCommand(['shell'])).toEqual({ command: 'shell', args: [] });
  });

  it('returns "shell" with --json flag', () => {
    expect(parseCommand(['shell', '--json'])).toEqual({
      command: 'shell',
      args: ['--json'],
    });
  });

  it('returns "init" for init argument', () => {
    expect(parseCommand(['init'])).toEqual({ command: 'init', args: [] });
  });

  it('returns "init" with flags preserved in args', () => {
    expect(parseCommand(['init', '--non-interactive', '--agents', 'claude-code,cursor'])).toEqual({
      command: 'init',
      args: ['--non-interactive', '--agents', 'claude-code,cursor'],
    });
  });

  it('passes --plain flag through to warmup args', () => {
    expect(parseCommand(['warmup', '--plain'])).toEqual({
      command: 'warmup',
      args: ['--plain'],
    });
  });
});

describe('parseCommand — setup', () => {
  it('parses "setup mcp" into command=setup, args=[mcp]', () => {
    const parsed = parseCommand(['setup', 'mcp']);
    expect(parsed.command).toBe('setup');
    expect(parsed.args).toEqual(['mcp']);
  });

  it('parses "setup" alone into command=setup, args=[]', () => {
    const parsed = parseCommand(['setup']);
    expect(parsed.command).toBe('setup');
    expect(parsed.args).toEqual([]);
  });

  it('forwards trailing flags on "setup mcp --non-interactive"', () => {
    const parsed = parseCommand(['setup', 'mcp', '--non-interactive']);
    expect(parsed.command).toBe('setup');
    expect(parsed.args).toEqual(['mcp', '--non-interactive']);
  });
});
