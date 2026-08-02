import { describe, it, expect } from 'vitest';
import { complete } from '../../../src/repl/completer.js';

describe('complete — top-level commands', () => {
  it('completes an empty line to the full command set', () => {
    const [matches, prefix] = complete('');
    expect(prefix).toBe('');
    // A representative slice of the command set the shell dispatches.
    for (const cmd of ['search', 'fetch', 'crawl', 'cache', 'help', 'exit']) {
      expect(matches).toContain(cmd);
    }
  });

  it('filters commands by the typed prefix', () => {
    const [matches, prefix] = complete('fe');
    expect(prefix).toBe('fe');
    expect(matches).toContain('fetch');
    expect(matches).not.toContain('search');
  });

  it('offers both find-similar spellings', () => {
    const [matches] = complete('find');
    expect(matches).toContain('find-similar');
    expect(matches).toContain('find_similar');
  });

  it('includes shell meta commands', () => {
    const [matches] = complete('.');
    expect(matches).toContain('.json');
    expect(matches).toContain('.history');
  });
});

describe('complete — subcommand verbs', () => {
  it('completes cache subcommand verbs after "cache "', () => {
    const [matches, prefix] = complete('cache ');
    expect(prefix).toBe('');
    expect(matches).toContain('stats');
    expect(matches).toContain('search');
    expect(matches).toContain('clear');
  });

  it('filters cache verbs by prefix', () => {
    const [matches, prefix] = complete('cache st');
    expect(prefix).toBe('st');
    expect(matches).toEqual(['stats']);
  });

  it('completes watch subcommand verbs', () => {
    const [matches] = complete('watch ');
    for (const verb of ['add', 'list', 'rm', 'run', 'pause', 'resume']) {
      expect(matches).toContain(verb);
    }
  });
});

describe('complete — flag names for the active command', () => {
  it('completes schema-derived + curated flags after a --', () => {
    const [matches, prefix] = complete('search --');
    expect(prefix).toBe('--');
    // Curated alias and a schema-derived flag both appear.
    expect(matches).toContain('--limit');
    expect(matches).toContain('--search-depth');
  });

  it('filters flags by the typed flag prefix', () => {
    const [matches, prefix] = complete('search --dom');
    expect(prefix).toBe('--dom');
    expect(matches).toContain('--domains');
    expect(matches.every((m) => m.startsWith('--dom'))).toBe(true);
  });

  it('offers no flags for an unknown command', () => {
    const [matches] = complete('bogus --');
    expect(matches).toEqual([]);
  });

  it('completes fetch boolean flags', () => {
    const [matches] = complete('fetch --scr');
    expect(matches).toContain('--screenshot');
  });
});

describe('complete — inside quotes', () => {
  it('offers no completion inside an open double quote', () => {
    const [matches] = complete('search "some qu');
    expect(matches).toEqual([]);
  });

  it('offers no completion inside an open single quote', () => {
    const [matches] = complete("fetch 'http://ex");
    expect(matches).toEqual([]);
  });

  it('resumes completion after a closed quote', () => {
    const [matches] = complete('search "term" --');
    expect(matches).toContain('--limit');
  });
});
