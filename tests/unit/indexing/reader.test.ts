import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLocalFile } from '../../../src/indexing/embed.js';

vi.mock('pdf-parse', () => ({
  PDFParse: class {
    constructor(_opts: unknown) {}
    async getText() {
      return { text: 'Extracted PDF body text for search indexing.' };
    }
    async destroy() {}
  },
}));

describe('readLocalFile', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wigolo-reader-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads markdown with title from first heading', async () => {
    const path = join(dir, 'note.md');
    writeFileSync(path, '# My Note\n\nhello');
    const r = await readLocalFile(path, 'note.md');
    expect(r.title).toBe('My Note');
    expect(r.markdown).toContain('hello');
    expect(r.extractorUsed).toBe('index:markdown');
  });

  it('reads plain text', async () => {
    const path = join(dir, 'readme.txt');
    writeFileSync(path, 'plain text content');
    const r = await readLocalFile(path, 'readme.txt');
    expect(r.mime).toBe('text/plain');
    expect(r.markdown).toBe('plain text content');
  });

  it('extracts PDF text via pdf-parse', async () => {
    const path = join(dir, 'doc.pdf');
    writeFileSync(path, '%PDF-1.4 fake');
    const r = await readLocalFile(path, 'doc.pdf');
    expect(r.extractorUsed).toBe('index:pdf');
    expect(r.markdown).toMatch(/Extracted PDF body/);
    expect(r.title).toBe('doc.pdf');
  });
});
