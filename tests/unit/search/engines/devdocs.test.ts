import { describe, it, expect } from 'vitest';
import { DevDocsEngine } from '../../../../src/search/engines/devdocs.js';

describe('DevDocsEngine', () => {
  it('has name set to devdocs', () => {
    expect(new DevDocsEngine().name).toBe('devdocs');
  });

  it('returns devdocs URLs for queries matching the hardcoded slug map', async () => {
    const results = await new DevDocsEngine().search('react hooks');
    expect(results.length).toBeGreaterThan(0);
    const reactHit = results.find((r) => r.url === 'https://devdocs.io/react');
    expect(reactHit).toBeDefined();
    expect(reactHit?.engine).toBe('devdocs');
    expect(reactHit?.title.toLowerCase()).toContain('react');
  });

  it('matches multiple slugs from query tokens', async () => {
    const results = await new DevDocsEngine().search('typescript node');
    const slugs = results.map((r) => r.url);
    expect(slugs).toContain('https://devdocs.io/typescript');
    expect(slugs).toContain('https://devdocs.io/node');
  });

  it('returns empty array when no token matches any slug', async () => {
    const results = await new DevDocsEngine().search('xyzzyqqqzzz nothing');
    expect(results).toEqual([]);
  });

  it('respects maxResults', async () => {
    const results = await new DevDocsEngine().search('react node typescript python css html', { maxResults: 2 });
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('assigns descending relevance_score across matches', async () => {
    const results = await new DevDocsEngine().search('react node typescript');
    if (results.length >= 2) {
      expect(results[0].relevance_score).toBeGreaterThan(results[results.length - 1].relevance_score);
    }
  });

  it('returns no published_date', async () => {
    const results = await new DevDocsEngine().search('react');
    for (const r of results) {
      expect(r.published_date).toBeUndefined();
    }
  });
});
