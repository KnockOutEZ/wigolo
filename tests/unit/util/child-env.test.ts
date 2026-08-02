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

  it('preserves *_PROXY vars by default (searxng child needs them)', () => {
    process.env.HTTP_PROXY = 'http://p:1';
    process.env.HTTPS_PROXY = 'http://p:2';
    process.env.http_proxy = 'http://p:3';
    process.env.https_proxy = 'http://p:4';
    process.env.ALL_PROXY = 'socks5://p:5';
    process.env.all_proxy = 'socks5://p:6';
    const env = sanitizedChildEnv();
    expect(env.HTTP_PROXY).toBe('http://p:1');
    expect(env.HTTPS_PROXY).toBe('http://p:2');
    expect(env.http_proxy).toBe('http://p:3');
    expect(env.https_proxy).toBe('http://p:4');
    expect(env.ALL_PROXY).toBe('socks5://p:5');
    expect(env.all_proxy).toBe('socks5://p:6');
  });

  it('strips ALL *_PROXY vars when stripProxy is set (browser child)', () => {
    process.env.HTTP_PROXY = 'http://p:1';
    process.env.HTTPS_PROXY = 'http://p:2';
    process.env.http_proxy = 'http://p:3';
    process.env.https_proxy = 'http://p:4';
    process.env.ALL_PROXY = 'socks5://p:5';
    process.env.all_proxy = 'socks5://p:6';
    process.env.PATH = '/usr/bin';
    const env = sanitizedChildEnv({ stripProxy: true });
    expect(env.HTTP_PROXY).toBeUndefined();
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.http_proxy).toBeUndefined();
    expect(env.https_proxy).toBeUndefined();
    expect(env.ALL_PROXY).toBeUndefined();
    expect(env.all_proxy).toBeUndefined();
    // Non-proxy env untouched.
    expect(env.PATH).toBe('/usr/bin');
  });

  it('still strips API-token secrets when stripProxy is set', () => {
    process.env.WIGOLO_API_TOKEN = 'secret';
    const env = sanitizedChildEnv({ stripProxy: true });
    expect(env.WIGOLO_API_TOKEN).toBeUndefined();
  });
});
