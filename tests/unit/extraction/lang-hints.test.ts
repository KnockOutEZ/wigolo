import { describe, it, expect } from 'vitest';
import { detectCodeLanguage } from '../../../src/extraction/lang-hints.js';

describe('detectCodeLanguage', () => {
  it('maps language-ts to ts', () => {
    expect(detectCodeLanguage('language-ts')).toBe('ts');
  });

  it('maps language-typescript alias to ts', () => {
    expect(detectCodeLanguage('language-typescript')).toBe('ts');
  });

  it('maps lang-js to js', () => {
    expect(detectCodeLanguage('lang-js')).toBe('js');
  });

  it('maps lang-javascript alias to js', () => {
    expect(detectCodeLanguage('lang-javascript')).toBe('js');
  });

  it('maps hljs-python to py', () => {
    expect(detectCodeLanguage('hljs-python')).toBe('py');
  });

  it('detects language-python within multiple classes (hljs language-python)', () => {
    expect(detectCodeLanguage('hljs language-python')).toBe('py');
  });

  it('maps prism-language-rust to rs', () => {
    expect(detectCodeLanguage('prism-language-rust')).toBe('rs');
  });

  it('keeps prism-language-tsx as tsx', () => {
    expect(detectCodeLanguage('prism-language-tsx')).toBe('tsx');
  });

  it('maps highlight-source-go to go', () => {
    expect(detectCodeLanguage('highlight-source-go')).toBe('go');
  });

  it('maps highlight-source-shell to sh', () => {
    expect(detectCodeLanguage('highlight-source-shell')).toBe('sh');
  });

  it('keeps language-bash unchanged', () => {
    expect(detectCodeLanguage('language-bash')).toBe('bash');
  });

  it('keeps language-yaml unchanged', () => {
    expect(detectCodeLanguage('language-yaml')).toBe('yaml');
  });

  it('keeps language-json unchanged', () => {
    expect(detectCodeLanguage('language-json')).toBe('json');
  });

  it('keeps language-sql unchanged', () => {
    expect(detectCodeLanguage('language-sql')).toBe('sql');
  });

  it('returns null for empty string', () => {
    expect(detectCodeLanguage('')).toBeNull();
  });

  it('returns null for unknown class', () => {
    expect(detectCodeLanguage('foo-bar baz')).toBeNull();
  });

  it('returns null for null/undefined', () => {
    expect(detectCodeLanguage(null)).toBeNull();
    expect(detectCodeLanguage(undefined)).toBeNull();
  });
});
