import { describe, it, expect } from 'vitest';
import { readStorageState, applyStorageState, type CookieJar, type PageEval } from '../../src/main/electron-storage';

function jar(initial: Array<Record<string, unknown>> = []): CookieJar & { store: Array<Record<string, unknown>> } {
  const store = [...initial];
  return {
    store,
    get: async () => store.map((c) => ({ ...c })) as never,
    set: async (d) => {
      store.push(d as Record<string, unknown>);
    },
  };
}

describe('electron-storage adapter', () => {
  it('reads Electron cookies into Playwright shape + current-origin localStorage', async () => {
    const cookies = jar([
      { name: 'sid', value: 'abc', domain: 'example.com', path: '/', secure: true, httpOnly: true, expirationDate: 1893456000, sameSite: 'lax' },
    ]);
    const out = await readStorageState(cookies, (async () => ({ token: 'jwt' })) as PageEval, 'https://example.com/app');
    expect(out.cookies).toEqual([
      expect.objectContaining({
        name: 'sid',
        value: 'abc',
        domain: 'example.com',
        path: '/',
        secure: true,
        httpOnly: true,
        expires: 1893456000,
        sameSite: 'Lax',
      }),
    ]);
    expect(out.origins).toEqual([{ origin: 'https://example.com', localStorage: [{ name: 'token', value: 'jwt' }] }]);
  });

  it('maps a session cookie (no expiry) to expires:-1, defaults sameSite to Lax, omits LS with unknown origin', async () => {
    const cookies = jar([{ name: 's', value: '1', domain: 'x.io', path: '/', secure: false, httpOnly: false }]);
    const out = await readStorageState(cookies, (async () => ({})) as PageEval, undefined);
    expect(out.cookies[0].expires).toBe(-1);
    expect(out.cookies[0].sameSite).toBe('Lax');
    expect(out.origins).toEqual([]);
  });

  it('preserves a leading-dot parent-domain cookie verbatim on read', async () => {
    const cookies = jar([{ name: 'p', value: '1', domain: '.example.com', path: '/', secure: true, httpOnly: true, sameSite: 'no_restriction' }]);
    const out = await readStorageState(cookies, (async () => ({})) as PageEval, undefined);
    expect(out.cookies[0].domain).toBe('.example.com');
    expect(out.cookies[0].sameSite).toBe('None');
  });

  it('applies cookies with a reconstructed url + sameSite mapping (leading dot → host-only url, domain kept); localStorage NOT written', async () => {
    const cookies = jar();
    await applyStorageState(cookies, {
      cookies: [
        { name: 'sid', value: 'abc', domain: 'example.com', path: '/', expires: 1893456000, httpOnly: true, secure: true, sameSite: 'Strict' },
        { name: 'p', value: '1', domain: '.example.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'None' },
      ],
      origins: [{ origin: 'https://example.com', localStorage: [{ name: 'ignored', value: 'x' }] }],
    });
    expect(cookies.store[0]).toEqual(
      expect.objectContaining({
        url: 'https://example.com/',
        name: 'sid',
        domain: 'example.com',
        secure: true,
        httpOnly: true,
        expirationDate: 1893456000,
        sameSite: 'strict',
      }),
    );
    expect(cookies.store[1]).toEqual(
      expect.objectContaining({ url: 'https://example.com/', name: 'p', domain: '.example.com', sameSite: 'no_restriction' }),
    );
    expect(cookies.store[1].expirationDate).toBeUndefined(); // session cookie: no expirationDate set
    // D-P5-8: RESTORE applies cookies ONLY — the applyStorageState signature has no page-eval param, so
    // localStorage cannot be written. Only the two cookies were set.
    expect(cookies.store).toHaveLength(2);
  });

  it('a cookie set failure never rejects the whole apply (best-effort restore)', async () => {
    const cookies: CookieJar = { get: async () => [], set: async () => { throw new Error('boom'); } };
    await expect(
      applyStorageState(cookies, {
        cookies: [{ name: 'a', value: 'b', domain: 'x.io', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'None' }],
        origins: [],
      }),
    ).resolves.toBeUndefined();
  });
});
