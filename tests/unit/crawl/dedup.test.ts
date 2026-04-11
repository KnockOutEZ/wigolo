import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { splitIntoBlocks, normalizeBlockText, deduplicatePages, getStoredBoilerplate, storeBoilerplate } from '../../../src/crawl/dedup.js';
import { initDatabase, closeDatabase } from '../../../src/cache/db.js';

vi.mock('../../../src/config.js', () => ({
  getConfig: () => ({
    logLevel: 'error',
    logFormat: 'json',
  }),
  resetConfig: vi.fn(),
}));

describe('splitIntoBlocks', () => {
  it('splits markdown by headings', () => {
    const md = '# Intro\n\nWelcome text.\n\n## Setup\n\nSetup instructions.\n\n# API\n\nAPI docs.';
    const blocks = splitIntoBlocks(md);
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toContain('# Intro');
    expect(blocks[0]).toContain('Welcome text.');
    expect(blocks[1]).toContain('## Setup');
    expect(blocks[1]).toContain('Setup instructions.');
    expect(blocks[2]).toContain('# API');
  });

  it('uses paragraph splitting when no headings', () => {
    const md = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.';
    const blocks = splitIntoBlocks(md);
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toBe('First paragraph.');
    expect(blocks[1]).toBe('Second paragraph.');
  });

  it('handles mixed heading levels correctly (non-overlapping)', () => {
    const md = '# Main\n\nIntro.\n\n## Sub\n\nSub content.\n\n### Deep\n\nDeep content.\n\n## Another\n\nMore.';
    const blocks = splitIntoBlocks(md);
    expect(blocks).toHaveLength(4);
    expect(blocks[0]).toContain('# Main');
    expect(blocks[0]).not.toContain('## Sub');
    expect(blocks[1]).toContain('## Sub');
    expect(blocks[2]).toContain('### Deep');
    expect(blocks[3]).toContain('## Another');
  });

  it('returns entire content as one block if single heading', () => {
    const md = '# Only\n\nSome content here.';
    const blocks = splitIntoBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain('# Only');
  });

  it('handles empty string', () => {
    expect(splitIntoBlocks('')).toEqual([]);
  });
});

describe('normalizeBlockText', () => {
  it('lowercases text', () => {
    expect(normalizeBlockText('Hello World')).toBe('hello world');
  });

  it('collapses whitespace', () => {
    expect(normalizeBlockText('hello   \n  world')).toBe('hello world');
  });

  it('trims', () => {
    expect(normalizeBlockText('  hello  ')).toBe('hello');
  });
});

describe('deduplicatePages', () => {
  it('strips blocks appearing in >50% of pages', () => {
    const nav = '## Navigation\n\n[Home](/) | [Docs](/docs) | [API](/api)';
    const pages = [
      { url: 'https://example.com/a', markdown: `# Page A\n\nContent A.\n\n${nav}` },
      { url: 'https://example.com/b', markdown: `# Page B\n\nContent B.\n\n${nav}` },
      { url: 'https://example.com/c', markdown: `# Page C\n\nContent C.\n\n${nav}` },
    ];

    const result = deduplicatePages(pages);

    for (const page of result) {
      expect(page.markdown).not.toContain('Navigation');
      expect(page.markdown).not.toContain('[Home]');
    }
    expect(result[0].markdown).toContain('Page A');
    expect(result[1].markdown).toContain('Page B');
  });

  it('keeps blocks appearing in <=50% of pages', () => {
    const pages = [
      { url: 'https://a.com/1', markdown: '# Unique A\n\nOnly here.' },
      { url: 'https://a.com/2', markdown: '# Unique B\n\nAlso unique.' },
      { url: 'https://a.com/3', markdown: '# Unique C\n\nDifferent.' },
    ];

    const result = deduplicatePages(pages);

    expect(result[0].markdown).toContain('Unique A');
    expect(result[1].markdown).toContain('Unique B');
    expect(result[2].markdown).toContain('Unique C');
  });

  it('handles pages with no headings (paragraph-level dedup)', () => {
    const footer = 'Copyright 2024 Example Inc. All rights reserved.';
    const pages = [
      { url: 'https://a.com/1', markdown: `Content A.\n\n${footer}` },
      { url: 'https://a.com/2', markdown: `Content B.\n\n${footer}` },
      { url: 'https://a.com/3', markdown: `Content C.\n\n${footer}` },
    ];

    const result = deduplicatePages(pages);

    for (const page of result) {
      expect(page.markdown).not.toContain('Copyright');
    }
  });

  it('returns empty array for empty input', () => {
    expect(deduplicatePages([], undefined)).toEqual([]);
  });

  it('returns unchanged for single page', () => {
    const pages = [{ url: 'https://a.com', markdown: '# Solo\n\nContent.' }];
    const result = deduplicatePages(pages, undefined);
    expect(result[0].markdown).toContain('Solo');
  });
});

describe('boilerplate storage', () => {
  beforeEach(() => {
    initDatabase(':memory:');
  });

  afterEach(() => {
    closeDatabase();
  });

  it('stores and retrieves boilerplate hashes for a domain', () => {
    const hashes = ['abc123', 'def456'];
    storeBoilerplate('example.com', hashes);
    const stored = getStoredBoilerplate('example.com');
    expect(stored).toEqual(hashes);
  });

  it('returns empty array for unknown domain', () => {
    const stored = getStoredBoilerplate('unknown.com');
    expect(stored).toEqual([]);
  });

  it('overwrites existing hashes on re-store', () => {
    storeBoilerplate('example.com', ['old']);
    storeBoilerplate('example.com', ['new1', 'new2']);
    const stored = getStoredBoilerplate('example.com');
    expect(stored).toEqual(['new1', 'new2']);
  });
});
