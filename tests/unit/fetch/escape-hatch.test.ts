import { describe, it, expect, vi } from 'vitest';
import {
  solverFetch,
  hostedReaderFetch,
  _guardedFollow,
  type EscapeHatchConfig,
} from '../../../src/fetch/escape-hatch.js';

const baseCfg: EscapeHatchConfig = {
  solverUrl: null,
  hostedReaderUrl: null,
  fetchAllowPrivate: false,
  maxRedirects: 5,
  fetchTimeoutMs: 10_000,
};

/** Build a minimal Response-like object for the injected fetch. */
function res(
  body: string,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(body, {
    status: init.status ?? 200,
    headers: init.headers ?? { 'content-type': 'application/json' },
  });
}

describe('solverFetch — off by default', () => {
  it('returns null when solverUrl is unset (never calls fetch)', async () => {
    const spy = vi.fn();
    const out = await solverFetch('https://target.example.com', baseCfg, { fetchImpl: spy });
    expect(out).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('hostedReaderFetch — off by default', () => {
  it('returns null when hostedReaderUrl is unset (never calls fetch)', async () => {
    const spy = vi.fn();
    const out = await hostedReaderFetch('https://target.example.com', baseCfg, { fetchImpl: spy });
    expect(out).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('solverFetch — happy path', () => {
  it('POSTs the target to a loopback solver and returns its cleared HTML', async () => {
    const cfg = { ...baseCfg, solverUrl: 'http://127.0.0.1:8191/v1' };
    const fetchImpl = vi.fn(async () =>
      res(JSON.stringify({ solution: { response: '<html>cleared</html>', status: 200 } })),
    );
    const out = await solverFetch('https://target.example.com/page', cfg, { fetchImpl });
    expect(out).not.toBeNull();
    expect(out!.html).toContain('cleared');
    expect(out!.method).toBe('http');
    // The solver endpoint was called (loopback allowed).
    expect(fetchImpl).toHaveBeenCalledOnce();
    const calledUrl = (fetchImpl.mock.calls[0] as unknown[])[0];
    expect(String(calledUrl)).toContain('127.0.0.1:8191');
  });

  it('allows a localhost solver URL', async () => {
    const cfg = { ...baseCfg, solverUrl: 'http://localhost:8191' };
    const fetchImpl = vi.fn(async () =>
      res(JSON.stringify({ solution: { response: '<html>ok</html>', status: 200 } })),
    );
    // `localhost` commonly resolves to BOTH 127.0.0.1 and ::1 on a dual-stack
    // host; pin the resolved-check lookup to the IPv4 record so this test
    // exercises "loopback solver via hostname" deterministically rather than
    // depending on the local resolver's IPv6 behavior.
    const lookup = (_h: string, _o: unknown, cb: (e: null, a: { address: string; family: number }[]) => void) =>
      cb(null, [{ address: '127.0.0.1', family: 4 }]);
    const out = await solverFetch('https://target.example.com', cfg, { fetchImpl, lookup });
    expect(out).not.toBeNull();
  });
});

describe('solverFetch — SSRF guards', () => {
  it('refuses a target URL that is a metadata IP (169.254.169.254)', async () => {
    const cfg = { ...baseCfg, solverUrl: 'http://127.0.0.1:8191' };
    const fetchImpl = vi.fn();
    const out = await solverFetch('http://169.254.169.254/latest/meta-data', cfg, { fetchImpl });
    expect(out).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a solver URL that is a metadata IP', async () => {
    const cfg = { ...baseCfg, solverUrl: 'http://169.254.169.254' };
    const fetchImpl = vi.fn();
    const out = await solverFetch('https://target.example.com', cfg, { fetchImpl });
    expect(out).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a target on a private 10.x when allowPrivate is false', async () => {
    const cfg = { ...baseCfg, solverUrl: 'http://127.0.0.1:8191' };
    const fetchImpl = vi.fn();
    const out = await solverFetch('http://10.1.2.3/internal', cfg, { fetchImpl });
    expect(out).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('hostedReaderFetch — SSRF guards + redirects', () => {
  it('refuses a target metadata IP', async () => {
    const cfg = { ...baseCfg, hostedReaderUrl: 'https://reader.example.com' };
    const fetchImpl = vi.fn();
    const out = await hostedReaderFetch('http://169.254.169.254/', cfg, { fetchImpl });
    expect(out).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses when the reader 302-redirects to a metadata IP', async () => {
    const cfg = { ...baseCfg, hostedReaderUrl: 'https://reader.example.com' };
    const fetchImpl = vi.fn(async () =>
      res('', { status: 302, headers: { location: 'http://169.254.169.254/' } }),
    );
    const out = await hostedReaderFetch('https://target.example.com', cfg, { fetchImpl });
    expect(out).toBeNull();
  });

  it('refuses when the reader 302-redirects to a hostname that RESOLVES to metadata', async () => {
    // The literal-only guard passes a redirect to `http://rebind.example/`
    // (an ordinary public-looking name). The fetch-time resolved re-check is
    // what catches it: `rebind.example` resolves to 169.254.169.254, so the
    // hop is refused before we connect — the static-record DNS SSRF bypass on
    // a redirect Location. (This is the resolved counterpart of the literal
    // 302→metadata case above.)
    const cfg = { ...baseCfg, hostedReaderUrl: 'https://reader.example.com' };
    const fetchImpl = vi.fn(async () =>
      res('', { status: 302, headers: { location: 'http://rebind.example/' } }),
    );
    // Host-aware lookup: only the redirect target resolves to metadata; hop 0
    // (the reader) and the original target stay public so they aren't the ones
    // being blocked.
    const lookup = (
      host: string,
      _o: unknown,
      cb: (e: null, a: { address: string; family: number }[]) => void,
    ) =>
      host === 'rebind.example'
        ? cb(null, [{ address: '169.254.169.254', family: 4 }])
        : cb(null, [{ address: '93.184.216.34', family: 4 }]);
    const out = await hostedReaderFetch('https://target.example.com', cfg, { fetchImpl, lookup });
    expect(out).toBeNull();
    // Hop 0 (the reader) was fetched and returned the 302; the redirect hop was
    // refused by the resolved re-check BEFORE a second fetch fired.
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('refuses when the reader 302-redirects to a 10.x and allowPrivate is false', async () => {
    const cfg = { ...baseCfg, hostedReaderUrl: 'https://reader.example.com' };
    const fetchImpl = vi.fn(async () =>
      res('', { status: 302, headers: { location: 'http://10.0.0.5/' } }),
    );
    const out = await hostedReaderFetch('https://target.example.com', cfg, { fetchImpl });
    expect(out).toBeNull();
  });

  it('FOLLOWS a 302 to a 10.x when allowPrivate is true', async () => {
    const cfg = {
      ...baseCfg,
      hostedReaderUrl: 'https://reader.example.com',
      fetchAllowPrivate: true,
    };
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      if (call === 1) return res('', { status: 302, headers: { location: 'http://10.0.0.5/rendered' } });
      return res('<html>private-rendered</html>', { headers: { 'content-type': 'text/html' } });
    });
    const out = await hostedReaderFetch('https://target.example.com', cfg, { fetchImpl });
    expect(out).not.toBeNull();
    expect(out!.html).toContain('private-rendered');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('stops after the hop cap (redirect loop) and returns null', async () => {
    const cfg = { ...baseCfg, hostedReaderUrl: 'https://reader.example.com', maxRedirects: 2 };
    const fetchImpl = vi.fn(async () =>
      res('', { status: 302, headers: { location: 'https://reader.example.com/again' } }),
    );
    const out = await hostedReaderFetch('https://target.example.com', cfg, { fetchImpl });
    expect(out).toBeNull();
  });
});

describe('guardedFollow hardening (security fixes)', () => {
  const cfg: EscapeHatchConfig = { ...baseCfg };

  it('fix 2 — refuses hop 0 when the start URL is a metadata IP (self-contained guard)', async () => {
    // The follower must NOT trust its input: a start URL pointing at the cloud
    // metadata endpoint is refused at hop 0, before any fetch is issued, even
    // though callers also pre-guard.
    const fetchImpl = vi.fn();
    const resp = await _guardedFollow(
      'http://169.254.169.254/latest/meta-data',
      { method: 'GET' },
      cfg,
      fetchImpl,
    );
    expect(resp).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fix 2 — refuses hop 0 when the start URL is a private 10.x and allowPrivate is false', async () => {
    const fetchImpl = vi.fn();
    const resp = await _guardedFollow('http://10.0.0.9/x', { method: 'GET' }, cfg, fetchImpl);
    expect(resp).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fix 1 — a 302 to a different public host is followed with GET and NO body', async () => {
    let call = 0;
    const seen: Array<{ url: string; method?: string; body?: unknown }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      call += 1;
      seen.push({ url, method: init.method, body: init.body });
      if (call === 1) {
        return res('', {
          status: 302,
          headers: { location: 'https://other-public-host.example/landing' },
        });
      }
      return res('<html>ok</html>', { headers: { 'content-type': 'text/html' } });
    });
    const resp = await _guardedFollow(
      'https://solver.example.com/v1',
      { method: 'POST', body: JSON.stringify({ url: 'https://target.example.com' }) },
      cfg,
      fetchImpl,
    );
    expect(resp).not.toBeNull();
    expect(seen.length).toBe(2);
    // Hop 0 keeps the original POST + body.
    expect(seen[0].method).toBe('POST');
    expect(seen[0].body).toBeTruthy();
    // The redirected hop must be a GET with NO body — the target URL is not
    // re-POSTed to a different public host.
    expect(seen[1].method).toBe('GET');
    expect(seen[1].body == null).toBe(true);
  });
});

describe('hostedReaderFetch — target URL encoding (fix 3)', () => {
  it('percent-encodes the target so its query cannot inject reader params', async () => {
    const cfg = { ...baseCfg, hostedReaderUrl: 'https://reader.example.com' };
    let composed = '';
    const fetchImpl = vi.fn(async (url: string) => {
      composed = url;
      return res('<html>ok</html>', { headers: { 'content-type': 'text/html' } });
    });
    await hostedReaderFetch(
      'https://target.example.com/page?secret=leaked&x=1',
      cfg,
      { fetchImpl },
    );
    // The reader request path carries the ENCODED target — no raw `?`/`&` from
    // the target leaks into the reader URL as its own query params.
    expect(composed).toContain(encodeURIComponent('https://target.example.com/page?secret=leaked&x=1'));
    // The composed URL's OWN query must be empty (target didn't inject params).
    const composedUrl = new URL(composed);
    expect(composedUrl.search).toBe('');
  });

  it("a crafted target with '/../' and '&x=' cannot inject reader path/params", async () => {
    const cfg = { ...baseCfg, hostedReaderUrl: 'https://reader.example.com/' };
    let composed = '';
    const fetchImpl = vi.fn(async (url: string) => {
      composed = url;
      return res('<html>ok</html>', { headers: { 'content-type': 'text/html' } });
    });
    await hostedReaderFetch('https://evil.example.com/a/../../admin&inject=1', cfg, { fetchImpl });
    const composedUrl = new URL(composed);
    // No injected query params on the reader URL.
    expect(composedUrl.search).toBe('');
    // The path did not traverse above the reader base (no `/admin` sibling).
    expect(composedUrl.pathname).not.toContain('/admin');
  });
});

describe('solverFetch — cookie scoping', () => {
  it('never surfaces a solver-returned cookie scoped to a different domain', async () => {
    // A solver returns a cookie for domain A; solverFetch is invoked for a
    // target on domain B. The returned result must not carry A's cookie for B.
    const cfg = { ...baseCfg, solverUrl: 'http://127.0.0.1:8191' };
    const fetchImpl = vi.fn(async () =>
      res(
        JSON.stringify({
          solution: {
            response: '<html>ok</html>',
            status: 200,
            cookies: [{ name: 'cf_clearance', value: 'x', domain: 'attacker.example' }],
          },
        }),
      ),
    );
    const out = await solverFetch('https://victim.example.com/page', cfg, { fetchImpl });
    expect(out).not.toBeNull();
    // The result must not inject a cross-domain cookie into headers.
    const cookieHeader = out!.headers['set-cookie'] ?? out!.headers['cookie'] ?? '';
    expect(cookieHeader).not.toContain('attacker.example');
  });
});
