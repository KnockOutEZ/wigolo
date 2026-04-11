import { describe, it, expect } from 'vitest';
import { extractMetadata } from '../../../src/extraction/extract.js';

describe('extractMetadata', () => {
  it('extracts title from <title> tag', () => {
    const html = '<html><head><title>My Page</title></head><body></body></html>';
    const result = extractMetadata(html);
    expect(result.title).toBe('My Page');
  });

  it('extracts description from meta tag', () => {
    const html = '<html><head><meta name="description" content="A great page"></head><body></body></html>';
    const result = extractMetadata(html);
    expect(result.description).toBe('A great page');
  });

  it('falls back to og:description when meta description missing', () => {
    const html = '<html><head><meta property="og:description" content="OG desc"></head><body></body></html>';
    const result = extractMetadata(html);
    expect(result.description).toBe('OG desc');
  });

  it('prefers meta description over og:description', () => {
    const html = `<html><head>
      <meta name="description" content="Meta desc">
      <meta property="og:description" content="OG desc">
    </head><body></body></html>`;
    const result = extractMetadata(html);
    expect(result.description).toBe('Meta desc');
  });

  it('extracts author from meta tag', () => {
    const html = '<html><head><meta name="author" content="Jane Smith"></head><body></body></html>';
    const result = extractMetadata(html);
    expect(result.author).toBe('Jane Smith');
  });

  it('extracts date from meta date tag', () => {
    const html = '<html><head><meta name="date" content="2025-08-15"></head><body></body></html>';
    const result = extractMetadata(html);
    expect(result.date).toBe('2025-08-15');
  });

  it('falls back to article:published_time for date', () => {
    const html = '<html><head><meta property="article:published_time" content="2025-08-15T10:00:00Z"></head><body></body></html>';
    const result = extractMetadata(html);
    expect(result.date).toBe('2025-08-15T10:00:00Z');
  });

  it('extracts keywords as array', () => {
    const html = '<html><head><meta name="keywords" content="typescript, generics, tutorial"></head><body></body></html>';
    const result = extractMetadata(html);
    expect(result.keywords).toEqual(['typescript', 'generics', 'tutorial']);
  });

  it('extracts og:image', () => {
    const html = '<html><head><meta property="og:image" content="https://example.com/img.png"></head><body></body></html>';
    const result = extractMetadata(html);
    expect(result.og_image).toBe('https://example.com/img.png');
  });

  it('returns empty object for HTML with no metadata', () => {
    const html = '<html><head></head><body><p>Hello</p></body></html>';
    const result = extractMetadata(html);
    expect(result.title).toBeUndefined();
    expect(result.description).toBeUndefined();
    expect(result.author).toBeUndefined();
  });

  it('handles all metadata fields together', () => {
    const html = `<html><head>
      <title>Full Page</title>
      <meta name="description" content="Full description">
      <meta name="author" content="John Doe">
      <meta name="date" content="2025-01-01">
      <meta name="keywords" content="a, b, c">
      <meta property="og:image" content="https://example.com/full.png">
    </head><body></body></html>`;
    const result = extractMetadata(html);
    expect(result).toEqual({
      title: 'Full Page',
      description: 'Full description',
      author: 'John Doe',
      date: '2025-01-01',
      keywords: ['a', 'b', 'c'],
      og_image: 'https://example.com/full.png',
    });
  });
});
