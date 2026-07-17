import { describe, it, expect } from 'vitest';
import {
  splitUserinfo,
  recomposeWithUserinfo,
  credentialKeychainUser,
  CREDENTIAL_URL_KEYS,
  playwrightProxyOption,
} from '../../../src/fetch/proxy-credentials.js';

describe('splitUserinfo', () => {
  it('splits user:pass@ from an http proxy URL', () => {
    const { bareUrl, userinfo } = splitUserinfo('http://alice:s3cret@proxy.example.com:8080');
    expect(userinfo).toBe('alice:s3cret');
    expect(bareUrl).toBe('http://proxy.example.com:8080/');
    expect(bareUrl).not.toContain('alice');
    expect(bareUrl).not.toContain('s3cret');
  });

  it('handles a username-only userinfo', () => {
    const { bareUrl, userinfo } = splitUserinfo('http://tokenonly@proxy.local:3128');
    expect(userinfo).toBe('tokenonly');
    expect(bareUrl).not.toContain('tokenonly');
  });

  it('returns null userinfo when there is none', () => {
    const { bareUrl, userinfo } = splitUserinfo('http://proxy.example.com:8080/');
    expect(userinfo).toBeNull();
    expect(bareUrl).toBe('http://proxy.example.com:8080/');
  });

  it('returns the input unchanged with null userinfo when unparseable', () => {
    const { bareUrl, userinfo } = splitUserinfo('not a url');
    expect(userinfo).toBeNull();
    expect(bareUrl).toBe('not a url');
  });

  it('preserves percent-encoded credentials verbatim in the userinfo', () => {
    const { userinfo } = splitUserinfo('http://user:p%40ss@proxy.example.com');
    expect(userinfo).toBe('user:p%40ss');
  });
});

describe('recomposeWithUserinfo', () => {
  it('injects userinfo into a bare URL', () => {
    const out = recomposeWithUserinfo('http://proxy.example.com:8080/', 'alice:s3cret');
    expect(out).toContain('alice:s3cret@');
    expect(out).toContain('proxy.example.com:8080');
  });

  it('round-trips split → recompose', () => {
    const original = 'http://alice:s3cret@proxy.example.com:8080';
    const { bareUrl, userinfo } = splitUserinfo(original);
    const back = recomposeWithUserinfo(bareUrl, userinfo!);
    const re = splitUserinfo(back);
    expect(re.userinfo).toBe('alice:s3cret');
  });

  it('returns the bare URL unchanged when userinfo is empty', () => {
    expect(recomposeWithUserinfo('http://proxy/', '')).toBe('http://proxy/');
  });
});

describe('credentialKeychainUser', () => {
  it('derives a stable per-field keychain user', () => {
    expect(credentialKeychainUser('proxyUrl')).toBe('proxyUrl-cred');
    expect(credentialKeychainUser('solverUrl')).toBe('solverUrl-cred');
    expect(credentialKeychainUser('hostedReaderUrl')).toBe('hostedReaderUrl-cred');
  });
});

describe('playwrightProxyOption', () => {
  it('returns undefined when useProxy is false', () => {
    expect(playwrightProxyOption('http://p:1', false)).toBeUndefined();
  });

  it('returns undefined when proxyUrl is null', () => {
    expect(playwrightProxyOption(null, true)).toBeUndefined();
  });

  it('splits credentials into structured server/username/password (not the server string)', () => {
    const opt = playwrightProxyOption('http://alice:s3cret@proxy.example.com:8080', true);
    expect(opt).toBeDefined();
    expect(opt!.username).toBe('alice');
    expect(opt!.password).toBe('s3cret');
    // The server must NOT carry the credentials inline.
    expect(opt!.server).not.toContain('alice');
    expect(opt!.server).not.toContain('s3cret');
    expect(opt!.server).toContain('proxy.example.com:8080');
  });

  it('returns a server-only option for a credential-free proxy', () => {
    const opt = playwrightProxyOption('http://proxy.example.com:8080', true);
    expect(opt).toBeDefined();
    expect(opt!.username).toBeUndefined();
    expect(opt!.password).toBeUndefined();
    expect(opt!.server).toContain('proxy.example.com:8080');
  });

  it('returns undefined for an unparseable proxy URL (fail-safe)', () => {
    expect(playwrightProxyOption('not a url', true)).toBeUndefined();
  });
});

describe('CREDENTIAL_URL_KEYS', () => {
  it('covers exactly the three credential-bearing URL settings', () => {
    expect([...CREDENTIAL_URL_KEYS].sort()).toEqual(
      ['hostedReaderUrl', 'proxyUrl', 'solverUrl'].sort(),
    );
  });
});
