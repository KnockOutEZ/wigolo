import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeBingTrackerUrl } from '../../../../src/search/engines/bing.js';

interface Sample { description: string; encoded: string; expected: string; }

const fixtures = JSON.parse(readFileSync(
  join(import.meta.dirname, '..', '..', '..', 'fixtures', 'bing-tracker-urls.json'),
  'utf-8',
)) as { samples: Sample[] };

describe('decodeBingTrackerUrl', () => {
  for (const s of fixtures.samples) {
    it(`decodes: ${s.description}`, () => {
      expect(decodeBingTrackerUrl(s.encoded)).toBe(s.expected);
    });
  }

  it('returns the input unchanged for a non-Bing URL', () => {
    const url = 'https://example.com/foo?q=bar';
    expect(decodeBingTrackerUrl(url)).toBe(url);
  });

  it('returns the input unchanged when the Bing URL has no u param', () => {
    const url = 'https://www.bing.com/ck/a?foo=bar';
    expect(decodeBingTrackerUrl(url)).toBe(url);
  });

  it('returns the input unchanged for malformed base64', () => {
    const url = 'https://www.bing.com/ck/a?u=xx!!!notbase64!!!';
    expect(decodeBingTrackerUrl(url)).toBe(url);
  });

  it('returns the input unchanged when decoded value is not a valid URL', () => {
    const encoded = Buffer.from('not a url').toString('base64');
    const url = `https://www.bing.com/ck/a?u=a1${encoded}`;
    expect(decodeBingTrackerUrl(url)).toBe(url);
  });

  it('returns input for a completely unparseable URL', () => {
    expect(decodeBingTrackerUrl('::::not a url::::')).toBe('::::not a url::::');
  });
});
