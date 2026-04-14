import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { initDatabase, closeDatabase } from '../../../src/cache/db.js';
import { cacheContent, normalizeUrl } from '../../../src/cache/store.js';
import { detectChange } from '../../../src/cache/change-detector.js';
import type { RawFetchResult, ExtractionResult } from '../../../src/types.js';

function makeRaw(url: string): RawFetchResult {
  return {
    url,
    finalUrl: url,
    html: '<html><body>hello</body></html>',
    contentType: 'text/html',
    statusCode: 200,
    method: 'http',
    headers: {},
  };
}

function makeExtraction(overrides: Partial<ExtractionResult> = {}): ExtractionResult {
  return {
    title: 'Test',
    markdown: '# Test\n\nContent.',
    metadata: {},
    links: [],
    images: [],
    extractor: 'defuddle',
    ...overrides,
  };
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

describe('detectChange', () => {
  beforeEach(() => {
    initDatabase(':memory:');
  });

  afterEach(() => {
    closeDatabase();
  });

  describe('no previous cache entry', () => {
    it('returns changed=false when URL was never cached', () => {
      const result = detectChange('https://example.com/new', 'some new markdown');
      expect(result.changed).toBe(false);
      expect(result.previousHash).toBeUndefined();
      expect(result.diffSummary).toBeUndefined();
    });

    it('returns changed=false for a different URL', () => {
      cacheContent(makeRaw('https://other.com'), makeExtraction({ markdown: 'other' }));
      const result = detectChange('https://example.com/unrelated', 'content');
      expect(result.changed).toBe(false);
    });
  });

  describe('content unchanged', () => {
    it('returns changed=false when content hash matches', () => {
      const markdown = '# Hello\n\nSame content.';
      cacheContent(makeRaw('https://example.com/page'), makeExtraction({ markdown }));

      const result = detectChange('https://example.com/page', markdown);
      expect(result.changed).toBe(false);
      expect(result.previousHash).toBeUndefined();
      expect(result.diffSummary).toBeUndefined();
    });

    it('returns changed=false even with different URL casing (normalized)', () => {
      const markdown = 'Same content';
      cacheContent(makeRaw('https://www.Example.COM/page/'), makeExtraction({ markdown }));

      const result = detectChange('https://example.com/page', markdown);
      expect(result.changed).toBe(false);
    });

    it('returns changed=false with tracking params stripped (normalized)', () => {
      const markdown = 'Content with tracking';
      cacheContent(
        makeRaw('https://example.com/page?utm_source=test'),
        makeExtraction({ markdown }),
      );

      const result = detectChange('https://example.com/page', markdown);
      expect(result.changed).toBe(false);
    });
  });

  describe('content changed', () => {
    it('returns changed=true when content hash differs', () => {
      const oldMarkdown = '# Hello\n\nOld content.';
      const newMarkdown = '# Hello\n\nNew content.';
      cacheContent(makeRaw('https://example.com/page'), makeExtraction({ markdown: oldMarkdown }));

      const result = detectChange('https://example.com/page', newMarkdown);
      expect(result.changed).toBe(true);
      expect(result.previousHash).toBe(sha256(oldMarkdown));
      expect(result.diffSummary).toBeDefined();
      expect(result.diffSummary).toContain('modified');
    });

    it('includes previous_hash as 64-char hex string', () => {
      cacheContent(makeRaw('https://example.com/a'), makeExtraction({ markdown: 'version 1' }));
      const result = detectChange('https://example.com/a', 'version 2');
      expect(result.previousHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('generates a diff summary with added/removed/modified counts', () => {
      const old = 'Line 1\nLine 2\nLine 3';
      const new_ = 'Line 1\nLine 2 updated\nLine 3\nLine 4';
      cacheContent(makeRaw('https://example.com/doc'), makeExtraction({ markdown: old }));

      const result = detectChange('https://example.com/doc', new_);
      expect(result.changed).toBe(true);
      expect(result.diffSummary).toMatch(/\d+ lines? added/);
    });

    it('detects change from empty to non-empty content', () => {
      cacheContent(makeRaw('https://example.com/empty'), makeExtraction({ markdown: '' }));
      const result = detectChange('https://example.com/empty', 'Now has content');
      expect(result.changed).toBe(true);
      expect(result.diffSummary).toContain('added');
    });

    it('detects change from non-empty to empty content', () => {
      cacheContent(makeRaw('https://example.com/filled'), makeExtraction({ markdown: 'Has content' }));
      const result = detectChange('https://example.com/filled', '');
      expect(result.changed).toBe(true);
      expect(result.diffSummary).toContain('removed');
    });
  });

  describe('unicode content', () => {
    it('handles unicode in old and new content', () => {
      const old = 'Bonjour le monde';
      const new_ = 'Bonjour tout le monde';
      cacheContent(makeRaw('https://example.com/unicode'), makeExtraction({ markdown: old }));
      const result = detectChange('https://example.com/unicode', new_);
      expect(result.changed).toBe(true);
      expect(typeof result.diffSummary).toBe('string');
    });

    it('handles CJK characters', () => {
      const old = 'Hello';
      const new_ = 'Hello World';
      cacheContent(makeRaw('https://example.com/cjk'), makeExtraction({ markdown: old }));
      const result = detectChange('https://example.com/cjk', new_);
      expect(result.changed).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('handles very long content', () => {
      const old = 'Line\n'.repeat(1000);
      const new_ = 'Line\n'.repeat(999) + 'Changed\n';
      cacheContent(makeRaw('https://example.com/long'), makeExtraction({ markdown: old }));
      const result = detectChange('https://example.com/long', new_);
      expect(result.changed).toBe(true);
    });

    it('returns correct type for all fields', () => {
      cacheContent(makeRaw('https://example.com/t'), makeExtraction({ markdown: 'a' }));
      const result = detectChange('https://example.com/t', 'b');
      expect(typeof result.changed).toBe('boolean');
      expect(typeof result.previousHash).toBe('string');
      expect(typeof result.diffSummary).toBe('string');
    });

    it('is idempotent (calling twice returns same result without caching new content)', () => {
      cacheContent(makeRaw('https://example.com/idem'), makeExtraction({ markdown: 'old' }));
      const r1 = detectChange('https://example.com/idem', 'new');
      const r2 = detectChange('https://example.com/idem', 'new');
      expect(r1.changed).toBe(r2.changed);
      expect(r1.previousHash).toBe(r2.previousHash);
    });
  });
});
