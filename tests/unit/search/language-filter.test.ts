import { describe, it, expect } from 'vitest';
import { filterByLanguage, type RawSearchResult } from '../../../src/search/language-filter.js';

const en = (i: number): RawSearchResult => ({
  url: `https://example.com/${i}`,
  title: 'PostgreSQL replication best practices',
  snippet: 'A guide to setting up streaming replication with WAL files',
  engine: 'bing',
});
const zh = (i: number): RawSearchResult => ({
  url: `https://baidu.com/${i}`,
  title: '人工智能教程',
  snippet: '本文介绍了人工智能的基础知识和应用场景',
  engine: 'bing',
});

describe('filterByLanguage', () => {
  it('keeps a fully English engine batch', () => {
    const out = filterByLanguage([en(1), en(2), en(3)], { target: 'en', dropThreshold: 0.4 });
    expect(out.results).toHaveLength(3);
    expect(out.discarded).toHaveLength(0);
    expect(out.warnings).toEqual([]);
  });

  it('drops the entire batch when >40% is non-target', () => {
    const out = filterByLanguage([en(1), zh(1), zh(2)], { target: 'en', dropThreshold: 0.4 });
    expect(out.results).toHaveLength(0);
    expect(out.warnings.some(w => w.includes('engine_language_mismatch'))).toBe(true);
  });

  it('drops invalid URLs', () => {
    const bad: RawSearchResult = { url: 'not a url', title: 'x', snippet: 'y', engine: 'bing' };
    const out = filterByLanguage([en(1), bad], { target: 'en', dropThreshold: 0.4 });
    expect(out.results).toHaveLength(1);
    expect(out.discarded.find(d => d.reason === 'invalid_url')).toBeDefined();
  });
});
