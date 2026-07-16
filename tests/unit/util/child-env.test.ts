import { describe, it, expect, afterEach } from 'vitest';
import { sanitizedChildEnv } from '../../../src/util/child-env.js';

describe('sanitizedChildEnv', () => {
  const original = { ...process.env };
  afterEach(() => {
    process.env = { ...original };
  });

  it('strips WIGOLO_API_TOKEN from the child environment', () => {
    process.env.WIGOLO_API_TOKEN = 'super-secret';
    const env = sanitizedChildEnv();
    expect(env.WIGOLO_API_TOKEN).toBeUndefined();
  });

  it('strips WIGOLO_API_TOKEN_FILE from the child environment', () => {
    process.env.WIGOLO_API_TOKEN_FILE = '/run/secrets/token';
    const env = sanitizedChildEnv();
    expect(env.WIGOLO_API_TOKEN_FILE).toBeUndefined();
  });

  it('preserves unrelated env vars like PATH', () => {
    process.env.PATH = '/usr/bin:/bin';
    process.env.SOME_PROXY = 'http://proxy';
    const env = sanitizedChildEnv();
    expect(env.PATH).toBe('/usr/bin:/bin');
    expect(env.SOME_PROXY).toBe('http://proxy');
  });

  it('returns a copy — mutating the result does not touch process.env', () => {
    process.env.WIGOLO_KEEP = 'yes';
    const env = sanitizedChildEnv();
    env.WIGOLO_KEEP = 'mutated';
    expect(process.env.WIGOLO_KEEP).toBe('yes');
  });
});
