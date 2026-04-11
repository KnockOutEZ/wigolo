import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defuddleExtract } from '../../../src/extraction/defuddle.js';

const fixturesDir = join(import.meta.dirname, '../../fixtures/extraction');
const loadFixture = (name: string) => readFileSync(join(fixturesDir, name), 'utf-8');

describe('defuddleExtract', () => {
  const url = 'https://example.com/blog/web-scraping';

  it('extracts title from article HTML', async () => {
    const html = loadFixture('article.html');
    const result = await defuddleExtract(html, url);
    expect(result).not.toBeNull();
    expect(result!.title).toContain('Building Modern Web Scrapers');
  });

  it('returns markdown content from article HTML', async () => {
    const html = loadFixture('article.html');
    const result = await defuddleExtract(html, url);
    expect(result).not.toBeNull();
    expect(result!.markdown.length).toBeGreaterThan(100);
    expect(result!.markdown).toContain('TypeScript');
  });

  it('sets extractor field to defuddle', async () => {
    const html = loadFixture('article.html');
    const result = await defuddleExtract(html, url);
    expect(result).not.toBeNull();
    expect(result!.extractor).toBe('defuddle');
  });

  it('returns null for minimal HTML below content threshold', async () => {
    const html = loadFixture('minimal.html');
    const result = await defuddleExtract(html, url);
    expect(result).toBeNull();
  });

  it('returns null for empty string input', async () => {
    const result = await defuddleExtract('', url);
    expect(result).toBeNull();
  });

  it('returns null for invalid HTML', async () => {
    const result = await defuddleExtract('not html at all', url);
    expect(result).toBeNull();
  });

  it('extracts content from pages with tables', async () => {
    const html = loadFixture('tables.html');
    const result = await defuddleExtract(html, 'https://example.com/report');
    expect(result).not.toBeNull();
    expect(result!.title).toContain('Quarterly');
  });

  it('extracts content from pages with code blocks', async () => {
    const html = loadFixture('code-blocks.html');
    const result = await defuddleExtract(html, 'https://example.com/tutorial');
    expect(result).not.toBeNull();
    expect(result!.markdown).toContain('async');
  });

  it('populates metadata fields when available', async () => {
    const html = loadFixture('article.html');
    const result = await defuddleExtract(html, url);
    expect(result).not.toBeNull();
    expect(result!.metadata.description).toBeDefined();
    expect(result!.metadata.author).toBe('Jane Developer');
    expect(result!.metadata.language).toBe('en');
  });

  it('initializes links and images as empty arrays', async () => {
    const html = loadFixture('article.html');
    const result = await defuddleExtract(html, url);
    expect(result).not.toBeNull();
    expect(result!.links).toEqual([]);
    expect(result!.images).toEqual([]);
  });
});
