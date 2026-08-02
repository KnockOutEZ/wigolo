import { describe, it, expect, afterEach } from 'vitest';
import {
  normalizeToken,
  resolveApiToken,
  isLoopbackBind,
  evaluateBindGate,
  checkAuth,
  type AuthContext,
} from '../../../src/daemon/rest/auth.js';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('normalizeToken', () => {
  it('returns null for undefined', () => {
    expect(normalizeToken(undefined)).toBeNull();
  });
  it('returns null for empty string', () => {
    expect(normalizeToken('')).toBeNull();
  });
  it('returns null for whitespace-only', () => {
    expect(normalizeToken('   ')).toBeNull();
    expect(normalizeToken('\t\n')).toBeNull();
  });
  it('trims and returns a real token', () => {
    expect(normalizeToken('  abc123  ')).toBe('abc123');
  });
});

describe('resolveApiToken', () => {
  const orig = { ...process.env };
  afterEach(() => {
    process.env = { ...orig };
    delete process.env.WIGOLO_API_TOKEN;
    delete process.env.WIGOLO_API_TOKEN_FILE;
  });

  it('returns null when neither env is set', () => {
    delete process.env.WIGOLO_API_TOKEN;
    delete process.env.WIGOLO_API_TOKEN_FILE;
    expect(resolveApiToken()).toBeNull();
  });

  it('reads WIGOLO_API_TOKEN env', () => {
    process.env.WIGOLO_API_TOKEN = 'env-token';
    expect(resolveApiToken()).toBe('env-token');
  });

  it('empty WIGOLO_API_TOKEN = unconfigured', () => {
    process.env.WIGOLO_API_TOKEN = '   ';
    delete process.env.WIGOLO_API_TOKEN_FILE;
    expect(resolveApiToken()).toBeNull();
  });

  it('falls back to WIGOLO_API_TOKEN_FILE when env unset', () => {
    delete process.env.WIGOLO_API_TOKEN;
    const dir = mkdtempSync(join(tmpdir(), 'wigolo-tok-'));
    const file = join(dir, 'token');
    writeFileSync(file, '  file-token\n');
    process.env.WIGOLO_API_TOKEN_FILE = file;
    expect(resolveApiToken()).toBe('file-token');
  });

  it('env value wins over file (precedence)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wigolo-tok-'));
    const file = join(dir, 'token');
    writeFileSync(file, 'file-token\n');
    process.env.WIGOLO_API_TOKEN = 'env-token';
    process.env.WIGOLO_API_TOKEN_FILE = file;
    expect(resolveApiToken()).toBe('env-token');
  });

  it('missing file path → null (fail closed)', () => {
    delete process.env.WIGOLO_API_TOKEN;
    process.env.WIGOLO_API_TOKEN_FILE = '/nonexistent/path/token';
    expect(resolveApiToken()).toBeNull();
  });
});

describe('isLoopbackBind', () => {
  it('TRUE for 127.x dotted literals', () => {
    expect(isLoopbackBind('127.0.0.1')).toBe(true);
    expect(isLoopbackBind('127.5.5.5')).toBe(true);
  });
  it('TRUE for ::1 forms and localhost', () => {
    expect(isLoopbackBind('::1')).toBe(true);
    expect(isLoopbackBind('[::1]')).toBe(true);
    expect(isLoopbackBind('0:0:0:0:0:0:0:1')).toBe(true);
    expect(isLoopbackBind('localhost')).toBe(true);
  });
  it('FALSE for wildcard binds', () => {
    expect(isLoopbackBind('0.0.0.0')).toBe(false);
    expect(isLoopbackBind('::')).toBe(false);
  });
  it('FALSE for empty / hostnames / LAN / public', () => {
    expect(isLoopbackBind('')).toBe(false);
    expect(isLoopbackBind('example.com')).toBe(false);
    expect(isLoopbackBind('192.168.1.5')).toBe(false);
    expect(isLoopbackBind('8.8.8.8')).toBe(false);
  });
});

describe('evaluateBindGate', () => {
  it('non-loopback + no token + no override → refuse', () => {
    const r = evaluateBindGate({ host: '0.0.0.0', token: null, allowUnauthenticated: false });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain('WIGOLO_API_TOKEN');
      expect(r.message).toContain('--allow-unauthenticated');
    }
  });
  it('loopback + no token → start', () => {
    expect(evaluateBindGate({ host: '127.0.0.1', token: null, allowUnauthenticated: false }).ok).toBe(true);
  });
  it('non-loopback + token → start', () => {
    expect(evaluateBindGate({ host: '0.0.0.0', token: 'secret', allowUnauthenticated: false }).ok).toBe(true);
  });
  it('non-loopback + override → start', () => {
    expect(evaluateBindGate({ host: '0.0.0.0', token: null, allowUnauthenticated: true }).ok).toBe(true);
  });
});

// checkAuth: request-time gate. Takes context {token, bindIsLoopback, allowUnauthenticated}
// and a request-shaped {hostHeader, originHeader, authHeader}. Returns
// {allow:true} | {allow:false, status, reason}.
function ctx(over: Partial<AuthContext>): AuthContext {
  return {
    token: null,
    bindIsLoopback: true,
    allowUnauthenticated: false,
    ...over,
  };
}

describe('checkAuth — token mode', () => {
  const base = ctx({ token: 'secret', bindIsLoopback: false });

  it('missing bearer → 401', () => {
    const r = checkAuth(base, { hostHeader: 'evil.com', originHeader: undefined, authHeader: undefined });
    expect(r.allow).toBe(false);
    if (!r.allow) expect(r.status).toBe(401);
  });
  it('wrong bearer → 401', () => {
    const r = checkAuth(base, { hostHeader: 'evil.com', originHeader: undefined, authHeader: 'Bearer wrong' });
    expect(r.allow).toBe(false);
    if (!r.allow) expect(r.status).toBe(401);
  });
  it('valid bearer + remote-style host → allow (Host skipped)', () => {
    const r = checkAuth(base, { hostHeader: 'my.remote.host:3333', originHeader: undefined, authHeader: 'Bearer secret' });
    expect(r.allow).toBe(true);
  });
  it('valid bearer + Origin present → allow (Origin ignored in token mode)', () => {
    const r = checkAuth(base, { hostHeader: 'my.remote.host', originHeader: 'https://evil.com', authHeader: 'Bearer secret' });
    expect(r.allow).toBe(true);
  });
});

describe('checkAuth — open loopback mode', () => {
  const base = ctx({ token: null, bindIsLoopback: true });

  it('allowed host, no origin → allow', () => {
    const r = checkAuth(base, { hostHeader: '127.0.0.1:3333', originHeader: undefined, authHeader: undefined });
    expect(r.allow).toBe(true);
  });
  it('bad host → 403', () => {
    const r = checkAuth(base, { hostHeader: 'evil.com', originHeader: undefined, authHeader: undefined });
    expect(r.allow).toBe(false);
    if (!r.allow) expect(r.status).toBe(403);
  });
  it('Origin header → 403 (rebinding/CSRF)', () => {
    const r = checkAuth(base, { hostHeader: '127.0.0.1', originHeader: 'https://evil.com', authHeader: undefined });
    expect(r.allow).toBe(false);
    if (!r.allow) expect(r.status).toBe(403);
  });
});

describe('checkAuth — override mode (non-loopback + allowUnauthenticated)', () => {
  const base = ctx({ token: null, bindIsLoopback: false, allowUnauthenticated: true });

  it('external host, no origin → allow (Host skipped)', () => {
    const r = checkAuth(base, { hostHeader: 'my.remote.host', originHeader: undefined, authHeader: undefined });
    expect(r.allow).toBe(true);
  });
  it('Origin header → 403 (kept)', () => {
    const r = checkAuth(base, { hostHeader: 'my.remote.host', originHeader: 'https://evil.com', authHeader: undefined });
    expect(r.allow).toBe(false);
    if (!r.allow) expect(r.status).toBe(403);
  });
});
