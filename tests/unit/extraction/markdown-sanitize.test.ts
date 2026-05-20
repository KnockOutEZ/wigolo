import { describe, it, expect } from 'vitest';
import { sanitizeExtractedMarkdown } from '../../../src/extraction/markdown-sanitize.js';

describe('sanitizeExtractedMarkdown', () => {
  it('strips a stray naked language label inside a fenced block', () => {
    const input = [
      '```mjs',
      "import fs from 'node:fs';",
      '',
      "const fs = require('node:fs');",
      '',
      'javascript',
      '```',
    ].join('\n');
    const out = sanitizeExtractedMarkdown(input);
    expect(out).not.toMatch(/^javascript$/m);
    expect(out).toContain("import fs from 'node:fs';");
  });

  it('keeps language label that follows a fence opener', () => {
    const input = '```javascript\nconst x = 1;\n```';
    expect(sanitizeExtractedMarkdown(input)).toBe(input);
  });

  it('keeps in-prose mention of javascript', () => {
    const input = 'I write javascript code\nand also python code.';
    expect(sanitizeExtractedMarkdown(input)).toBe(input);
  });

  it('strips multiple language labels in one fence', () => {
    const input = '```ts\nconst x = 1;\ntypescript\nconst y = 2;\njavascript\n```';
    const out = sanitizeExtractedMarkdown(input);
    expect(out).not.toMatch(/^javascript$/m);
    expect(out).not.toMatch(/^typescript$/m);
    expect(out).toContain('const x = 1;');
    expect(out).toContain('const y = 2;');
  });

  it('is idempotent', () => {
    const input = '```mjs\nfoo()\njavascript\n```';
    expect(sanitizeExtractedMarkdown(sanitizeExtractedMarkdown(input))).toBe(sanitizeExtractedMarkdown(input));
  });

  it('unglues language prefix stuck to first identifier (TS docs pattern)', () => {
    const input = '```markdown\ntsfunction uppercaseStrings(x: string) {\n    return x.toUpperCase();\n}\n```';
    const out = sanitizeExtractedMarkdown(input);
    expect(out).toMatch(/^```ts$/m);
    expect(out).toContain('function uppercaseStrings(x: string)');
    expect(out).not.toContain('tsfunction');
  });

  it('unglues js prefix on a const declaration', () => {
    const input = '```markdown\njsconst x = 1;\n```';
    const out = sanitizeExtractedMarkdown(input);
    expect(out).toMatch(/^```js$/m);
    expect(out).toContain('const x = 1;');
  });

  it('leaves real code starting with two-letter identifier alone', () => {
    const input = '```ts\ntsConfig.target = "es2020";\n```';
    const out = sanitizeExtractedMarkdown(input);
    expect(out).toContain('tsConfig.target');
  });
});
