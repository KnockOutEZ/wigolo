import { describe, it, expect } from 'vitest';
import { htmlToMarkdown, extractSection, extractLinksAndImages } from '../../../src/extraction/markdown.js';

describe('htmlToMarkdown', () => {
  it('converts basic HTML to markdown', () => {
    const html = '<p>Hello <strong>world</strong></p>';
    const result = htmlToMarkdown(html);
    expect(result).toContain('Hello');
    expect(result).toContain('world');
  });

  it('converts headings with atx style', () => {
    const html = '<h1>Title</h1><h2>Subtitle</h2>';
    const result = htmlToMarkdown(html);
    expect(result).toMatch(/^# Title/m);
    expect(result).toMatch(/^## Subtitle/m);
  });

  it('converts HTML tables to markdown tables', () => {
    const html = `
      <table>
        <thead><tr><th>Name</th><th>Age</th></tr></thead>
        <tbody><tr><td>Alice</td><td>30</td></tr></tbody>
      </table>
    `;
    const result = htmlToMarkdown(html);
    expect(result).toContain('Name');
    expect(result).toContain('Age');
    expect(result).toContain('Alice');
    expect(result).toContain('|');
    expect(result).toContain('---');
  });

  it('converts table with multiple rows', () => {
    const html = `
      <table>
        <thead><tr><th>Col1</th><th>Col2</th></tr></thead>
        <tbody>
          <tr><td>A</td><td>B</td></tr>
          <tr><td>C</td><td>D</td></tr>
        </tbody>
      </table>
    `;
    const result = htmlToMarkdown(html);
    expect(result).toContain('Col1');
    expect(result).toContain('Col2');
    expect(result).toContain('A');
    expect(result).toContain('C');
  });

  it('preserves fenced code blocks from pre/code', () => {
    const html = '<pre><code>const x = 1;\nconst y = 2;</code></pre>';
    const result = htmlToMarkdown(html);
    expect(result).toContain('```');
    expect(result).toContain('const x = 1;');
  });

  it('preserves inline code', () => {
    const html = '<p>Use the <code>npm install</code> command</p>';
    const result = htmlToMarkdown(html);
    expect(result).toContain('`npm install`');
  });

  it('converts links', () => {
    const html = '<a href="https://example.com">Example</a>';
    const result = htmlToMarkdown(html);
    expect(result).toContain('[Example](https://example.com)');
  });

  it('converts images', () => {
    const html = '<img src="https://example.com/img.png" alt="Image">';
    const result = htmlToMarkdown(html);
    expect(result).toContain('![Image](https://example.com/img.png)');
  });

  it('handles empty string', () => {
    const result = htmlToMarkdown('');
    expect(result).toBe('');
  });

  it('strips script and style tags', () => {
    const html = '<p>Content</p><script>alert("x")</script><style>body{}</style>';
    const result = htmlToMarkdown(html);
    expect(result).toContain('Content');
    expect(result).not.toContain('alert');
    expect(result).not.toContain('body{}');
  });
});

describe('extractSection', () => {
  const markdown = `# Introduction

This is the intro.

## Installation

Run npm install.

## Usage

Use the tool.

### Advanced Usage

For advanced users.

## Installation Tips

Extra tips here.
`;

  it('returns full content with matched=false when section not found', () => {
    const result = extractSection(markdown, 'Nonexistent');
    expect(result.matched).toBe(false);
    expect(result.content).toBe(markdown);
  });

  it('exact match (case-insensitive) returns section content', () => {
    const result = extractSection(markdown, 'Installation');
    expect(result.matched).toBe(true);
    expect(result.content).toContain('Run npm install');
    expect(result.content).not.toContain('Use the tool');
  });

  it('exact match is case-insensitive', () => {
    const result = extractSection(markdown, 'installation');
    expect(result.matched).toBe(true);
    expect(result.content).toContain('Run npm install');
  });

  it('section content stops at next heading of equal or higher level', () => {
    const result = extractSection(markdown, 'Installation');
    expect(result.content).not.toContain('Usage');
  });

  it('subsection is included within parent section', () => {
    const result = extractSection(markdown, 'Usage');
    expect(result.matched).toBe(true);
    expect(result.content).toContain('Use the tool');
    expect(result.content).toContain('Advanced Usage');
    expect(result.content).not.toContain('Installation Tips');
  });

  it('section_index selects among multiple exact matches', () => {
    const result = extractSection(markdown, 'Installation', 1);
    expect(result.matched).toBe(true);
    expect(result.content).toContain('Extra tips here');
    expect(result.content).not.toContain('Run npm install');
  });

  it('defaults to first match when section_index is 0', () => {
    const result0 = extractSection(markdown, 'Installation', 0);
    const resultDefault = extractSection(markdown, 'Installation');
    expect(result0.content).toBe(resultDefault.content);
  });

  it('returns full content with matched=false when index out of bounds', () => {
    const result = extractSection(markdown, 'Installation', 99);
    expect(result.matched).toBe(false);
    expect(result.content).toBe(markdown);
  });

  it('substring match when no exact match', () => {
    const result = extractSection(markdown, 'Install');
    expect(result.matched).toBe(true);
    expect(result.content).toContain('Run npm install');
  });

  it('exact match takes priority over substring match', () => {
    const result = extractSection(markdown, 'Usage');
    expect(result.matched).toBe(true);
    expect(result.content).toContain('Use the tool');
    expect(result.content).not.toContain('Run npm install');
  });

  it('matches top-level heading', () => {
    const result = extractSection(markdown, 'Introduction');
    expect(result.matched).toBe(true);
    expect(result.content).toContain('This is the intro');
    // Level-1 heading has no equal/higher-level heading after it, so content extends to EOF
    expect(result.content).toContain('# Introduction');
  });

  it('handles markdown with no headings', () => {
    const plain = 'Just some plain text\nwith no headings here.';
    const result = extractSection(plain, 'anything');
    expect(result.matched).toBe(false);
    expect(result.content).toBe(plain);
  });

  it('returns heading line as part of section content', () => {
    const result = extractSection(markdown, 'Usage');
    expect(result.content).toMatch(/^## Usage/m);
  });
});

describe('extractLinksAndImages', () => {
  it('extracts links from markdown', () => {
    const md = 'See [Google](https://google.com) and [GitHub](https://github.com)';
    const result = extractLinksAndImages(md);
    expect(result.links).toContain('https://google.com');
    expect(result.links).toContain('https://github.com');
    expect(result.images).toHaveLength(0);
  });

  it('extracts images from markdown', () => {
    const md = '![Logo](https://example.com/logo.png) and ![Banner](https://example.com/banner.png)';
    const result = extractLinksAndImages(md);
    expect(result.images).toContain('https://example.com/logo.png');
    expect(result.images).toContain('https://example.com/banner.png');
    expect(result.links).toHaveLength(0);
  });

  it('does not include image URLs in links array', () => {
    const md = '![Alt](https://example.com/img.png) [Link](https://example.com/page)';
    const result = extractLinksAndImages(md);
    expect(result.links).not.toContain('https://example.com/img.png');
    expect(result.links).toContain('https://example.com/page');
  });

  it('deduplicates URLs', () => {
    const md = '[A](https://example.com) [B](https://example.com)';
    const result = extractLinksAndImages(md);
    expect(result.links.filter(l => l === 'https://example.com')).toHaveLength(1);
  });

  it('deduplicates image URLs', () => {
    const md = '![A](https://example.com/img.png) ![B](https://example.com/img.png)';
    const result = extractLinksAndImages(md);
    expect(result.images.filter(i => i === 'https://example.com/img.png')).toHaveLength(1);
  });

  it('returns empty arrays for markdown with no links or images', () => {
    const md = 'Just plain text with no links.';
    const result = extractLinksAndImages(md);
    expect(result.links).toHaveLength(0);
    expect(result.images).toHaveLength(0);
  });

  it('handles empty string', () => {
    const result = extractLinksAndImages('');
    expect(result.links).toHaveLength(0);
    expect(result.images).toHaveLength(0);
  });

  it('returns separate arrays for links and images', () => {
    const md = '[Link](https://link.com) ![Img](https://img.com/a.png)';
    const result = extractLinksAndImages(md);
    expect(result.links).toContain('https://link.com');
    expect(result.images).toContain('https://img.com/a.png');
    expect(result.links).not.toContain('https://img.com/a.png');
    expect(result.images).not.toContain('https://link.com');
  });
});
