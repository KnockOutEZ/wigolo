import { describe, it, expect } from 'vitest';
import { describeFetchError } from '../../../src/fetch/error-describe.js';

function withCause(message: string, code: string): Error {
  const cause = new Error(message);
  (cause as NodeJS.ErrnoException).code = code;
  const wrapper = new TypeError('fetch failed');
  (wrapper as unknown as { cause: Error }).cause = cause;
  return wrapper;
}

describe('describeFetchError', () => {
  it('drills through cause to surface ENOTFOUND', () => {
    const err = withCause('getaddrinfo ENOTFOUND nope.invalid', 'ENOTFOUND');
    expect(describeFetchError(err).reason).toContain('ENOTFOUND');
    expect(describeFetchError(err).reason).toContain('DNS');
  });

  it('drills through cause to surface ECONNREFUSED', () => {
    const err = withCause('connect ECONNREFUSED 127.0.0.1:1', 'ECONNREFUSED');
    expect(describeFetchError(err).reason).toContain('ECONNREFUSED');
  });

  it('handles AbortError as timeout', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    expect(describeFetchError(err).reason).toMatch(/timed out/i);
  });

  it('falls back to message when no code present', () => {
    expect(describeFetchError(new Error('whatever broke')).reason).toBe('whatever broke');
  });

  it('handles non-Error throwables', () => {
    expect(describeFetchError('plain string')).toEqual({ reason: 'plain string' });
  });
});
