import { describe, it, expect } from 'vitest';
import {
  extractKeyTerms,
  removeStopwords,
  extractHeadings,
  extractBoldText,
  extractFirstParagraph,
} from '../../../src/embedding/key-terms.js';

describe('extractKeyTerms', () => {
  it('extracts terms from title and content', () => {
    const terms = extractKeyTerms(
      '# React Hooks Guide\n\nReact Hooks let you use **state** and other features without writing classes. They were introduced in React 16.8.',
      'React Hooks - Complete Guide',
    );
    expect(terms).toContain('react');
    expect(terms).toContain('hooks');
    expect(terms).toContain('state');
    expect(terms.length).toBeGreaterThan(0);
    expect(terms.length).toBeLessThanOrEqual(20);
  });

  it('returns empty array for empty input', () => {
    const terms = extractKeyTerms('', '');
    expect(terms).toEqual([]);
  });

  it('returns empty array for whitespace-only input', () => {
    const terms = extractKeyTerms('   \n\n  ', '  ');
    expect(terms).toEqual([]);
  });

  it('removes common stopwords', () => {
    const terms = extractKeyTerms(
      'The quick brown fox jumps over the lazy dog and this is a test of the system',
      'A Test Title',
    );
    expect(terms).not.toContain('the');
    expect(terms).not.toContain('and');
    expect(terms).not.toContain('is');
    expect(terms).not.toContain('a');
    expect(terms).not.toContain('of');
    expect(terms).not.toContain('over');
    expect(terms).toContain('quick');
    expect(terms).toContain('brown');
    expect(terms).toContain('fox');
  });

  it('deduplicates terms', () => {
    const terms = extractKeyTerms(
      '# React React React\n\nReact is great. React hooks are useful.',
      'React Guide',
    );
    const reactCount = terms.filter(t => t === 'react').length;
    expect(reactCount).toBeLessThanOrEqual(1);
  });

  it('limits to max 20 terms', () => {
    const longContent = Array.from({ length: 50 }, (_, i) => `uniqueword${i}`).join(' ');
    const terms = extractKeyTerms(longContent, 'Many Words Title');
    expect(terms.length).toBeLessThanOrEqual(20);
  });

  it('normalizes to lowercase', () => {
    const terms = extractKeyTerms(
      '# TypeScript Guide\n\nTypeScript provides **Static Typing**.',
      'TYPESCRIPT GUIDE',
    );
    for (const term of terms) {
      expect(term).toBe(term.toLowerCase());
    }
  });

  it('extracts bold text as high-signal terms', () => {
    const terms = extractKeyTerms(
      'This is about **machine learning** and **neural networks** in practice.',
      'AI Guide',
    );
    expect(terms).toContain('machine');
    expect(terms).toContain('learning');
    expect(terms).toContain('neural');
    expect(terms).toContain('networks');
  });

  it('extracts heading text as high-signal terms', () => {
    const terms = extractKeyTerms(
      '# Introduction\n\n## Getting Started\n\n### Configuration Options\n\nSome body text here.',
      'Setup Guide',
    );
    expect(terms).toContain('introduction');
    expect(terms).toContain('getting');
    expect(terms).toContain('started');
    expect(terms).toContain('configuration');
    expect(terms).toContain('options');
  });

  it('prioritizes title terms', () => {
    const terms = extractKeyTerms(
      'Some random body text that is not very important.',
      'Kubernetes Deployment Strategy',
    );
    expect(terms).toContain('kubernetes');
    expect(terms).toContain('deployment');
    expect(terms).toContain('strategy');
  });

  it('handles markdown content with code blocks', () => {
    const terms = extractKeyTerms(
      '# API Reference\n\n```typescript\nfunction hello() { return "world"; }\n```\n\nThe **API** provides endpoints.',
      'API Docs',
    );
    expect(terms).toContain('api');
    expect(terms).toContain('reference');
  });

  it('handles content with special characters', () => {
    const terms = extractKeyTerms(
      '# C++ Programming\n\nC++ is a **general-purpose** language. It supports OOP & templates.',
      'C++ Guide',
    );
    expect(terms.length).toBeGreaterThan(0);
    expect(terms).toContain('programming');
  });

  it('handles unicode content', () => {
    const terms = extractKeyTerms(
      '# Webpack Konfiguration\n\nWebpack ermoglicht **Bundling** von Modulen.',
      'Webpack Guide',
    );
    expect(terms.length).toBeGreaterThan(0);
    expect(terms).toContain('webpack');
  });

  it('strips URLs from content before extraction', () => {
    const terms = extractKeyTerms(
      'Visit https://example.com/very/long/path?query=test for details about **React**.',
      'Links Page',
    );
    expect(terms).not.toContain('https');
    expect(terms).not.toContain('example');
    expect(terms).toContain('react');
  });

  it('handles content with only headings', () => {
    const terms = extractKeyTerms(
      '# First Heading\n## Second Heading\n### Third Heading',
      '',
    );
    expect(terms.length).toBeGreaterThan(0);
    expect(terms).toContain('first');
    expect(terms).toContain('heading');
  });

  it('handles very short content', () => {
    const terms = extractKeyTerms('Hello', 'Hi');
    expect(terms.length).toBeGreaterThan(0);
  });
});

describe('removeStopwords', () => {
  it('removes English stopwords', () => {
    const result = removeStopwords(['the', 'quick', 'brown', 'fox', 'is', 'a']);
    expect(result).toEqual(['quick', 'brown', 'fox']);
  });

  it('returns empty array for all stopwords', () => {
    const result = removeStopwords(['the', 'a', 'is', 'and', 'or', 'but']);
    expect(result).toEqual([]);
  });

  it('handles empty input', () => {
    const result = removeStopwords([]);
    expect(result).toEqual([]);
  });

  it('preserves non-stopwords', () => {
    const result = removeStopwords(['react', 'hooks', 'components']);
    expect(result).toEqual(['react', 'hooks', 'components']);
  });

  it('removes single-character words', () => {
    const result = removeStopwords(['a', 'b', 'react', 'i']);
    expect(result).toContain('react');
    expect(result).not.toContain('a');
    expect(result).not.toContain('i');
  });
});

describe('extractHeadings', () => {
  it('extracts h1-h3 headings from markdown', () => {
    const headings = extractHeadings('# Title\n## Subtitle\n### Section\n#### Ignored');
    expect(headings).toContain('Title');
    expect(headings).toContain('Subtitle');
    expect(headings).toContain('Section');
    expect(headings).not.toContain('Ignored');
  });

  it('returns empty array for no headings', () => {
    expect(extractHeadings('Just some text.')).toEqual([]);
  });

  it('handles empty input', () => {
    expect(extractHeadings('')).toEqual([]);
  });
});

describe('extractBoldText', () => {
  it('extracts **bold** text from markdown', () => {
    const bold = extractBoldText('This is **important** and **critical** text.');
    expect(bold).toContain('important');
    expect(bold).toContain('critical');
  });

  it('extracts __bold__ text from markdown', () => {
    const bold = extractBoldText('This is __also bold__ text.');
    expect(bold).toContain('also bold');
  });

  it('returns empty array for no bold text', () => {
    expect(extractBoldText('No bold here.')).toEqual([]);
  });

  it('handles empty input', () => {
    expect(extractBoldText('')).toEqual([]);
  });
});

describe('extractFirstParagraph', () => {
  it('extracts first 200 chars of first paragraph', () => {
    const text = extractFirstParagraph('# Title\n\nThis is the first paragraph with some content.');
    expect(text).toContain('This is the first paragraph');
  });

  it('returns empty string for empty input', () => {
    expect(extractFirstParagraph('')).toBe('');
  });

  it('truncates to 200 characters', () => {
    const long = '# Title\n\n' + 'a'.repeat(500);
    const text = extractFirstParagraph(long);
    expect(text.length).toBeLessThanOrEqual(200);
  });

  it('skips heading lines', () => {
    const text = extractFirstParagraph('# Heading\n## Subheading\n\nActual content here.');
    expect(text).not.toContain('# Heading');
    expect(text).toContain('Actual content here');
  });
});
