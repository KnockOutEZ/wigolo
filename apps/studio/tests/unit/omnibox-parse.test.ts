import { describe, it, expect } from 'vitest';
import { parseOmnibox } from '../../src/renderer/omnibox-parse';

describe('parseOmnibox — one box must never misroute (spec §3 dual-mode omnibox)', () => {
  it('passes full URLs through untouched', () => {
    expect(parseOmnibox('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
  });
  it('upgrades bare domains to https', () => {
    expect(parseOmnibox('example.com')).toBe('https://example.com');
    expect(parseOmnibox('sub.example.co.uk/path')).toBe('https://sub.example.co.uk/path');
  });
  it('keeps localhost and ports navigable — DOM-to-code flow depends on it', () => {
    expect(parseOmnibox('localhost:3000')).toBe('http://localhost:3000');
    expect(parseOmnibox('127.0.0.1:8080/x')).toBe('http://127.0.0.1:8080/x');
  });
  it('treats anything with spaces as a search', () => {
    expect(parseOmnibox('best pricing page examples')).toBe(
      'https://duckduckgo.com/?q=best%20pricing%20page%20examples',
    );
  });
  it('treats dotless single words as a search, not a hostname', () => {
    expect(parseOmnibox('electron')).toBe('https://duckduckgo.com/?q=electron');
  });
});
