import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentAppearsEmpty } from '../../../src/fetch/content-check.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const fixture = (name: string) =>
  readFileSync(join(__dirname, '../../fixtures/spa-shells', name), 'utf-8');

describe('contentAppearsEmpty', () => {
  it('detects React SPA shell', () => {
    expect(contentAppearsEmpty(fixture('react-spa.html'))).toBe(true);
  });

  it('detects empty Next.js page', () => {
    expect(contentAppearsEmpty(fixture('next-empty.html'))).toBe(true);
  });

  it('detects Vue SPA shell', () => {
    expect(contentAppearsEmpty(fixture('vue-spa.html'))).toBe(true);
  });

  it('detects noscript-required pages', () => {
    expect(contentAppearsEmpty(fixture('noscript-required.html'))).toBe(true);
  });

  it('detects script-heavy pages', () => {
    expect(contentAppearsEmpty(fixture('script-heavy.html'))).toBe(true);
  });

  it('passes normal pages', () => {
    expect(contentAppearsEmpty(fixture('normal-page.html'))).toBe(false);
  });

  it('detects thin content pages', () => {
    expect(contentAppearsEmpty(fixture('thin-content.html'))).toBe(true);
  });
});
