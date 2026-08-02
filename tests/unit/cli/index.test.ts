import { describe, it, expect } from 'vitest';
import { parseCommand } from '../../../src/cli/index.js';

describe('parseCommand', () => {
  it('returns "mcp" for no arguments', () => {
    expect(parseCommand([])).toEqual({ command: 'mcp', args: [] });
  });

  it('returns "mcp" for explicit "mcp" subcommand', () => {
    expect(parseCommand(['mcp'])).toEqual({ command: 'mcp', args: [] });
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

  it('routes unknown subcommand to "unknown" with name in args[0]', () => {
    expect(parseCommand(['foobar'])).toEqual({ command: 'unknown', args: ['foobar'] });
  });

  it('returns "help" for --help', () => {
    expect(parseCommand(['--help'])).toEqual({ command: 'help', args: [] });
  });

  it('returns "help" for -h', () => {
    expect(parseCommand(['-h'])).toEqual({ command: 'help', args: [] });
  });

  it('returns "help" for help subcommand', () => {
    expect(parseCommand(['help'])).toEqual({ command: 'help', args: [] });
  });

  it('returns "version" for --version', () => {
    expect(parseCommand(['--version'])).toEqual({ command: 'version', args: [] });
  });

  it('returns "version" for -V', () => {
    expect(parseCommand(['-V'])).toEqual({ command: 'version', args: [] });
  });

  it('returns "version" for version subcommand', () => {
    expect(parseCommand(['version'])).toEqual({ command: 'version', args: [] });
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

  it('returns "tune" for tune argument', () => {
    expect(parseCommand(['tune'])).toEqual({ command: 'tune', args: [] });
  });

  it('routes "tune show <domain>" preserving the subcommand + domain + flags', () => {
    expect(parseCommand(['tune', 'show', 'example.com', '--json'])).toEqual({
      command: 'tune',
      args: ['show', 'example.com', '--json'],
    });
  });

  it('passes --plain flag through to warmup args', () => {
    expect(parseCommand(['warmup', '--plain'])).toEqual({
      command: 'warmup',
      args: ['--plain'],
    });
  });
});

describe('parseCommand — one-shot tools', () => {
  const tools = [
    'search',
    'fetch',
    'crawl',
    'extract',
    'cache',
    'find-similar',
    'research',
    'agent',
    'diff',
    'watch',
  ] as const;

  for (const t of tools) {
    it(`routes "${t}" to command=${t} with remaining args`, () => {
      const parsed = parseCommand([t, 'foo', '--json']);
      expect(parsed.command).toBe(t);
      expect(parsed.args).toEqual(['foo', '--json']);
    });
  }

  it('routes the snake-case "find_similar" alias', () => {
    const parsed = parseCommand(['find_similar', 'https://x.com']);
    expect(parsed.command).toBe('find_similar');
    expect(parsed.args).toEqual(['https://x.com']);
  });

  it('preserves multi-word query positionals in args', () => {
    const parsed = parseCommand(['search', 'react', 'hooks', '--limit=5']);
    expect(parsed.command).toBe('search');
    expect(parsed.args).toEqual(['react', 'hooks', '--limit=5']);
  });

  it('routes "watch add <url>" preserving the subcommand + url', () => {
    const parsed = parseCommand(['watch', 'add', 'https://x.com', '--interval', '120']);
    expect(parsed.command).toBe('watch');
    expect(parsed.args).toEqual(['add', 'https://x.com', '--interval', '120']);
  });

  it('still defaults bare invocation to mcp', () => {
    expect(parseCommand([])).toEqual({ command: 'mcp', args: [] });
  });
});

describe('parseCommand — skills', () => {
  it('parses "skills add" into command=skills, args=[add]', () => {
    const parsed = parseCommand(['skills', 'add']);
    expect(parsed.command).toBe('skills');
    expect(parsed.args).toEqual(['add']);
  });

  it('parses "skills" alone into command=skills, args=[]', () => {
    const parsed = parseCommand(['skills']);
    expect(parsed.command).toBe('skills');
    expect(parsed.args).toEqual([]);
  });

  it('forwards packs + flags on "skills add"', () => {
    const parsed = parseCommand(['skills', 'add', 'wigolo-search', '--agent', 'cline', '--json']);
    expect(parsed.command).toBe('skills');
    expect(parsed.args).toEqual(['add', 'wigolo-search', '--agent', 'cline', '--json']);
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
