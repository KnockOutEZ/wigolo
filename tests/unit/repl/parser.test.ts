import { describe, it, expect } from 'vitest';
import { tokenize, parseArgs, type ParsedArgs } from '../../../src/repl/parser.js';

describe('tokenize', () => {
  it('splits simple whitespace-separated tokens', () => {
    expect(tokenize('search hello world')).toEqual(['search', 'hello', 'world']);
  });

  it('handles double-quoted strings with spaces', () => {
    expect(tokenize('search "hello world"')).toEqual(['search', 'hello world']);
  });

  it('handles single-quoted strings with spaces', () => {
    expect(tokenize("search 'hello world'")).toEqual(['search', 'hello world']);
  });

  it('handles mixed quotes', () => {
    expect(tokenize(`search "it's here" 'he said "hi"'`)).toEqual([
      'search', "it's here", 'he said "hi"',
    ]);
  });

  it('handles escaped quotes inside double quotes', () => {
    expect(tokenize('search "say \\"hi\\""')).toEqual(['search', 'say "hi"']);
  });

  it('handles empty input', () => {
    expect(tokenize('')).toEqual([]);
  });

  it('handles whitespace-only input', () => {
    expect(tokenize('   ')).toEqual([]);
  });

  it('handles trailing whitespace', () => {
    expect(tokenize('search hello   ')).toEqual(['search', 'hello']);
  });

  it('handles leading whitespace', () => {
    expect(tokenize('   search hello')).toEqual(['search', 'hello']);
  });

  it('handles tabs and multiple spaces', () => {
    expect(tokenize("search\t\thello   world")).toEqual(['search', 'hello', 'world']);
  });

  it('handles unicode content', () => {
    expect(tokenize('search "reacte 18 konfiguration"')).toEqual(['search', 'reacte 18 konfiguration']);
  });

  it('handles unicode CJK content', () => {
    expect(tokenize('search "React 18"')).toEqual(['search', 'React 18']);
  });

  it('handles --key=value as a single token', () => {
    expect(tokenize('search hello --limit=5')).toEqual(['search', 'hello', '--limit=5']);
  });

  it('handles negative numbers', () => {
    expect(tokenize('fetch http://example.com --max-chars -1')).toEqual([
      'fetch', 'http://example.com', '--max-chars', '-1',
    ]);
  });

  it('preserves URLs with special characters', () => {
    expect(tokenize('fetch https://example.com/path?q=hello&p=1')).toEqual([
      'fetch', 'https://example.com/path?q=hello&p=1',
    ]);
  });

  it('handles unclosed quote as rest of input', () => {
    expect(tokenize('search "unclosed')).toEqual(['search', 'unclosed']);
  });
});

describe('parseArgs', () => {
  it('extracts positional args and flags', () => {
    const result = parseArgs(['search', 'hello world', '--limit=5', '--domains=a.com,b.com']);
    expect(result.command).toBe('search');
    expect(result.positional).toEqual(['hello world']);
    expect(result.flags.limit).toBe('5');
    expect(result.flags.domains).toBe('a.com,b.com');
  });

  it('handles --key value (space-separated) flags', () => {
    const result = parseArgs(['crawl', 'https://ex.com', '--depth', '3', '--max-pages', '10']);
    expect(result.command).toBe('crawl');
    expect(result.positional).toEqual(['https://ex.com']);
    expect(result.flags.depth).toBe('3');
    expect(result.flags['max-pages']).toBe('10');
  });

  it('handles --key=value flags', () => {
    const result = parseArgs(['search', 'query', '--limit=5']);
    expect(result.flags.limit).toBe('5');
  });

  it('handles boolean flags (no value)', () => {
    const result = parseArgs(['fetch', 'https://ex.com', '--json']);
    expect(result.flags.json).toBe('true');
  });

  it('returns empty for no input', () => {
    const result = parseArgs([]);
    expect(result.command).toBe('');
    expect(result.positional).toEqual([]);
    expect(result.flags).toEqual({});
  });

  it('handles command with no args', () => {
    const result = parseArgs(['help']);
    expect(result.command).toBe('help');
    expect(result.positional).toEqual([]);
    expect(result.flags).toEqual({});
  });

  it('treats a flag value starting with -- as a boolean flag plus next flag', () => {
    const result = parseArgs(['search', 'q', '--verbose', '--limit=3']);
    expect(result.flags.verbose).toBe('true');
    expect(result.flags.limit).toBe('3');
  });

  it('handles multiple positional args', () => {
    const result = parseArgs(['cache', 'search', 'my query']);
    expect(result.command).toBe('cache');
    expect(result.positional).toEqual(['search', 'my query']);
  });

  it('normalizes flag names by stripping leading dashes', () => {
    const result = parseArgs(['search', 'q', '--from-date=2024-01-01']);
    expect(result.flags['from-date']).toBe('2024-01-01');
  });
});
