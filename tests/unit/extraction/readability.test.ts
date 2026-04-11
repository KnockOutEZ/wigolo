import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readabilityExtract } from '../../../src/extraction/readability.js';

const fixturesDir = join(import.meta.dirname, '../../fixtures/extraction');
const loadFixture = (name: string) => readFileSync(join(fixturesDir, name), 'utf-8');

describe('readabilityExtract', () => {
  const url = 'https://example.com/blog/web-scraping';

  it('extracts title from article HTML', () => {
    const html = loadFixture('article.html');
    const result = readabilityExtract(html, url);
    expect(result).not.toBeNull();
    expect(result!.title).toContain('Building Modern Web Scrapers');
  });

  it('returns markdown content from article HTML', () => {
    const html = loadFixture('article.html');
    const result = readabilityExtract(html, url);
    expect(result).not.toBeNull();
    expect(result!.markdown.length).toBeGreaterThan(100);
    expect(result!.markdown).toContain('TypeScript');
  });

  it('sets extractor field to readability', () => {
    const html = loadFixture('article.html');
    const result = readabilityExtract(html, url);
    expect(result).not.toBeNull();
    expect(result!.extractor).toBe('readability');
  });

  it('returns null for minimal HTML below content threshold', () => {
    const html = loadFixture('minimal.html');
    const result = readabilityExtract(html, url);
    expect(result).toBeNull();
  });

  it('returns null for empty string input', () => {
    const result = readabilityExtract('', url);
    expect(result).toBeNull();
  });

  it('returns null for invalid HTML', () => {
    const result = readabilityExtract('not html at all', url);
    expect(result).toBeNull();
  });

  it('extracts content from pages with tables', () => {
    const html = loadFixture('tables.html');
    const result = readabilityExtract(html, 'https://example.com/report');
    expect(result).not.toBeNull();
    expect(result!.title).toContain('Quarterly');
  });

  it('extracts content from pages with code blocks', () => {
    const html = loadFixture('code-blocks.html');
    const result = readabilityExtract(html, 'https://example.com/tutorial');
    expect(result).not.toBeNull();
    expect(result!.markdown).toContain('async');
  });

  it('converts HTML content to markdown format', () => {
    const html = loadFixture('article.html');
    const result = readabilityExtract(html, url);
    expect(result).not.toBeNull();
    expect(result!.markdown).toMatch(/^#/m);
  });

  it('initializes links and images as empty arrays', () => {
    const html = loadFixture('article.html');
    const result = readabilityExtract(html, url);
    expect(result).not.toBeNull();
    expect(result!.links).toEqual([]);
    expect(result!.images).toEqual([]);
  });
});
