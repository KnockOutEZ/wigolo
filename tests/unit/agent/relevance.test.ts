import { describe, it, expect } from 'vitest';
import { isValidCandidateUrl, isBlocklistedDomain, preFilterCandidates } from '../../../src/agent/relevance.js';
import { agentSourcesToSearchResults, scoreAndFilterSources } from '../../../src/agent/executor.js';

describe('isValidCandidateUrl', () => {
  it('rejects unparseable URLs', () => {
    expect(isValidCandidateUrl('not a url')).toBe(false);
  });
  it('rejects DuckDuckGo redirect endpoints', () => {
    expect(isValidCandidateUrl('https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com')).toBe(false);
  });
  it('accepts ordinary http/https URLs', () => {
    expect(isValidCandidateUrl('https://example.com/a/b')).toBe(true);
  });
  it('rejects r.jina.ai URLs', () => {
    expect(isValidCandidateUrl('https://r.jina.ai/https://example.com')).toBe(false);
  });
});

describe('isBlocklistedDomain', () => {
  it('blocks gaming forums', () => {
    expect(isBlocklistedDomain('https://elitepvpers.com/x')).toBe(true);
  });
  it('blocks Chinese consumer forums for technical queries', () => {
    expect(isBlocklistedDomain('https://zhidao.baidu.com/q')).toBe(true);
    expect(isBlocklistedDomain('https://jingyan.baidu.com/q')).toBe(true);
    expect(isBlocklistedDomain('https://zhihu.com/q')).toBe(true);
  });
  it('does not block reputable domains', () => {
    expect(isBlocklistedDomain('https://postgresql.org/docs')).toBe(false);
    expect(isBlocklistedDomain('https://stackoverflow.com/q/1')).toBe(false);
  });
  it('treats unparseable URLs as blocklisted (fail-closed)', () => {
    expect(isBlocklistedDomain('not a url')).toBe(true);
  });
});

describe('agentSourcesToSearchResults', () => {
  it('maps AgentSource[] → MergedSearchResult[] preserving url and title', () => {
    const sources = [{ url: 'https://a', title: 'A', body: 'aa' }];
    const out = agentSourcesToSearchResults(sources);
    expect(out[0].url).toBe('https://a');
    expect(out[0].title).toBe('A');
  });
});

describe('scoreAndFilterSources', () => {
  it('excludes sources with score < 0.1 with excluded_reason', async () => {
    const sources = [
      { url: 'https://a', title: 'PostgreSQL release notes', body: 'PostgreSQL 17.0 was released...' },
      { url: 'https://b', title: 'Cooking pasta recipes', body: 'Boil water and add pasta' },
    ];
    const { kept, excluded } = await scoreAndFilterSources('latest postgres release', sources, { threshold: 0.1 });
    expect(kept.find((k) => k.url === 'https://a')).toBeDefined();
    const exclB = excluded.find((e) => e.source.url === 'https://b');
    expect(exclB?.excluded_reason).toMatch(/^below_threshold/);
  });
});

describe('preFilterCandidates', () => {
  it('partitions inputs by validity then blocklist, preserving extra fields and order', () => {
    const items = [
      { url: 'https://example.com/a', score: 1 },
      { url: 'not a url', score: 2 },
      { url: 'https://zhihu.com/q', score: 3 },
      { url: 'https://example.com/b', score: 4 },
      { url: 'https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com', score: 5 },
    ];
    const result = preFilterCandidates(items);
    expect(result.kept).toEqual([
      { url: 'https://example.com/a', score: 1 },
      { url: 'https://example.com/b', score: 4 },
    ]);
    expect(result.excluded).toEqual([
      { item: { url: 'not a url', score: 2 }, reason: 'invalid_url' },
      { item: { url: 'https://zhihu.com/q', score: 3 }, reason: 'blocklisted_domain' },
      { item: { url: 'https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com', score: 5 }, reason: 'invalid_url' },
    ]);
  });
});
