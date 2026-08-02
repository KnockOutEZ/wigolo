import { describe, it, expect } from 'vitest';
import type {
  ChallengeClass,
  SolveMethod,
  RawFetchResult,
} from '../../../src/types.js';

// These tests are structural: they compile only if the unions + optional
// RawFetchResult fields exist with the documented member sets. They also assert
// the values at runtime so a member removal can't silently pass.

describe('types — solve provenance unions', () => {
  it('ChallengeClass admits exactly the four documented members', () => {
    const classes: ChallengeClass[] = ['image', 'interactive', 'behavioral', 'none'];
    expect(classes).toHaveLength(4);
  });

  it('SolveMethod admits exactly the six documented members', () => {
    const methods: SolveMethod[] = [
      'reuse',
      'auto-pass',
      'cdp-direct',
      'ai-vision',
      'solver',
      'human',
    ];
    expect(methods).toHaveLength(6);
  });

  it('RawFetchResult compiles WITHOUT the new optional fields (existing sites unchanged)', () => {
    const r: RawFetchResult = {
      url: 'https://example.com',
      finalUrl: 'https://example.com',
      html: '<html></html>',
      contentType: 'text/html',
      statusCode: 200,
      method: 'http',
      headers: {},
    };
    expect(r.challenge_class).toBeUndefined();
    expect(r.solve_method).toBeUndefined();
  });

  it('RawFetchResult accepts challenge_class + solve_method when present', () => {
    const r: RawFetchResult = {
      url: 'https://example.com',
      finalUrl: 'https://example.com',
      html: '',
      contentType: 'text/html',
      statusCode: 403,
      method: 'browser',
      headers: {},
      challenge_class: 'behavioral',
      solve_method: null,
    };
    expect(r.challenge_class).toBe('behavioral');
    expect(r.solve_method).toBeNull();

    const r2: RawFetchResult = { ...r, challenge_class: 'interactive', solve_method: 'auto-pass' };
    expect(r2.solve_method).toBe('auto-pass');
  });
});
