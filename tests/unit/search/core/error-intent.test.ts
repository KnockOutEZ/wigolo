import { describe, it, expect } from 'vitest';
import {
  extractErrorTokens,
  hasErrorIntent,
  resultMatchesErrorToken,
} from '../../../../src/search/core/error-intent.js';

describe('extractErrorTokens — SHAPE-based atomic error-token detection', () => {
  it('detects SCREAMING_SNAKE error codes (any ecosystem)', () => {
    expect(extractErrorTokens('ERR_MODULE_NOT_FOUND cannot find package')).toEqual([
      'ERR_MODULE_NOT_FOUND',
    ]);
    expect(extractErrorTokens('ERR_SSL_PROTOCOL_ERROR chrome')).toEqual([
      'ERR_SSL_PROTOCOL_ERROR',
    ]);
    // Postgres SQLSTATE-style codes are 5-char alnum; the surrounding word too
    expect(extractErrorTokens('SQLSTATE 23505 duplicate key value')).toContain('SQLSTATE');
  });

  it('detects bracketed compiler error codes across languages', () => {
    // Rust
    expect(extractErrorTokens('error[E0499] cannot borrow as mutable')).toContain('E0499');
    // C#
    expect(extractErrorTokens('error CS0246 type or namespace')).toContain('CS0246');
    // TypeScript — bare code is accepted alongside an error-context word
    expect(extractErrorTokens('error TS2345 argument of type is not assignable')).toContain('TS2345');
  });

  it('does NOT treat digit-bearing spec/codec tokens as error codes without error context', () => {
    // H264 codec, RFC number — no error-context word, must not fire.
    expect(extractErrorTokens('H264 encoding bitrate settings')).toEqual([]);
    expect(extractErrorTokens('RFC7231 http caching semantics')).toEqual([]);
  });

  it('detects bare all-caps errno tokens alongside error context', () => {
    expect(extractErrorTokens('npm ERR code ERESOLVE unable to resolve')).toContain('ERESOLVE');
    expect(extractErrorTokens('Error: listen EADDRINUSE address already in use')).toContain('EADDRINUSE');
    // A SCREAMING_SNAKE token establishes context for a co-occurring errno.
    expect(extractErrorTokens('ERR_MODULE_NOT_FOUND ENOENT no such file')).toContain('ENOENT');
  });

  it('does NOT treat ordinary uppercase acronyms as error tokens', () => {
    // These are common non-error acronyms — must not fire.
    expect(extractErrorTokens('HTTP REST API design best practices')).toEqual([]);
    expect(extractErrorTokens('JSON schema validation guide')).toEqual([]);
    expect(extractErrorTokens('AWS S3 bucket policy example')).toEqual([]);
    expect(extractErrorTokens('SQL GROUP BY vs HAVING')).toEqual([]);
  });

  it('does NOT treat all-caps English words starting with E as errno codes (no context)', () => {
    // These match the errno SHAPE (^E[A-Z]{4,}$) but are ordinary words — the
    // error-context gate must keep them out.
    expect(extractErrorTokens('EXPORT DEFAULT vs named exports javascript')).toEqual([]);
    expect(extractErrorTokens('ENGINE options for a game in rust')).toEqual([]);
    expect(extractErrorTokens('ENCRYPT AES data at rest')).toEqual([]);
    expect(extractErrorTokens('EXAMPLE usage of a library')).toEqual([]);
  });

  it('does NOT fire on a normal query that merely contains one uppercase word', () => {
    expect(extractErrorTokens('best GRAPHICS card for gaming 2026')).toEqual([]);
    expect(extractErrorTokens('React useState hook tutorial')).toEqual([]);
    expect(extractErrorTokens('what is DNS and how does it work')).toEqual([]);
  });

  // Over-fire probe: realistic non-error queries whose tokens match an error
  // SHAPE but are ordinary words / constants / hardware-spec identifiers. None
  // may be tagged. (feedback_gate_negative_tests_required)
  it('does NOT tag common all-caps words that match the errno shape', () => {
    for (const q of [
      'ENGINE options mysql innodb',
      'EXPORT default vs named exports javascript',
      'ENABLE cors in express',
      'EXTEND a class in typescript',
      'EUROPE timezone list',
    ]) {
      expect(extractErrorTokens(q), q).toEqual([]);
    }
  });

  it('does NOT tag STATUS / STATE-style ordinary labels', () => {
    expect(extractErrorTokens('STATUS 200 OK meaning')).toEqual([]);
    expect(extractErrorTokens('what is my EXIT STATUS')).toEqual([]);
  });

  it('does NOT tag config/env/API SCREAMING_SNAKE constants', () => {
    for (const q of [
      'DATABASE_URL env var format',
      'set JAVA_HOME on windows',
      'GL_TEXTURE_2D opengl example',
      'AWS_ACCESS_KEY_ID rotation policy',
      'NEXT_PUBLIC_API_URL nextjs',
    ]) {
      expect(extractErrorTokens(q), q).toEqual([]);
    }
  });

  it('does NOT tag hardware/codec/spec tokens even with an incidental error word', () => {
    for (const q of [
      'H264 error playing video',
      'B550 motherboard crash',
      'RTX4090 throttling exception',
      'RFC7231 cannot understand caching',
      'ISO8601 date failed to parse',
    ]) {
      expect(extractErrorTokens(q), q).toEqual([]);
    }
  });

  it('STILL tags error-flavoured SCREAMING_SNAKE and prefixed compiler codes', () => {
    // guard against the over-fire fix throwing out the real positives
    expect(extractErrorTokens('ERR_MODULE_NOT_FOUND cannot find package')).toContain('ERR_MODULE_NOT_FOUND');
    expect(extractErrorTokens('build failed with error CS0246')).toContain('CS0246');
    expect(extractErrorTokens('rust error[E0499] borrow')).toContain('E0499');
  });
});

describe('hasErrorIntent', () => {
  it('is true when an atomic error token is present', () => {
    expect(hasErrorIntent('ERR_MODULE_NOT_FOUND cannot find package exports')).toBe(true);
    expect(hasErrorIntent('error[E0308] mismatched types rust')).toBe(true);
  });

  it('is false for ordinary dev / how-to / brand queries', () => {
    expect(hasErrorIntent('how to center a div in css')).toBe(false);
    expect(hasErrorIntent('next.js app router tutorial')).toBe(false);
    expect(hasErrorIntent('HTTP REST API design')).toBe(false);
    expect(hasErrorIntent('postgres index performance tuning')).toBe(false);
  });
});

describe('resultMatchesErrorToken — per-result survival predicate', () => {
  const tokens = ['ERR_MODULE_NOT_FOUND'];

  it('is true when the token appears in title', () => {
    expect(
      resultMatchesErrorToken(
        { title: 'Error [ERR_MODULE_NOT_FOUND]: Cannot find module', url: 'https://x', snippet: '' },
        tokens,
      ),
    ).toBe(true);
  });

  it('is true when the token appears in snippet (case-insensitive)', () => {
    expect(
      resultMatchesErrorToken(
        { title: 'Fix Node.js', url: 'https://x', snippet: 'the err_module_not_found error happens when' },
        tokens,
      ),
    ).toBe(true);
  });

  it('is false when the token appears nowhere (broadcaster / dictionary junk)', () => {
    expect(
      resultMatchesErrorToken(
        { title: 'ERR | English meaning - Cambridge Dictionary', url: 'https://dictionary.cambridge.org', snippet: 'err definition' },
        tokens,
      ),
    ).toBe(false);
    expect(
      resultMatchesErrorToken(
        { title: 'Err : Urban Rustic Thai', url: 'https://errurbanrusticthai.co.th', snippet: 'restaurant bangkok' },
        tokens,
      ),
    ).toBe(false);
  });

  it('matches the bracketed compiler-code token against the digit code', () => {
    expect(
      resultMatchesErrorToken(
        { title: 'E0499 - Error codes index', url: 'https://doc.rust-lang.org', snippet: '' },
        ['E0499'],
      ),
    ).toBe(true);
  });
});
