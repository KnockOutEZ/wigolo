import { createServer, type Server } from 'node:http';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

/**
 * WHY this file is separate from browser-redirect-ssrf.test.ts: it runs the
 * browser tier with the per-hop CDP interceptor DISABLED, which is the state
 * firefox and webkit are permanently in (they have no CDP) and the state a
 * silently displaced interceptor would leave Chromium in.
 *
 * A mutation probe found this gap: deleting the post-navigation
 * `assertNavigationChainAllowed` call from browser-pool.ts left all 48 other
 * tests green, because on Chromium the interceptor always refuses first. A
 * backstop nothing can observe is a backstop nothing protects.
 *
 * The guarantee under test is deliberately the WEAKER one, and is asserted as
 * such: without an interceptor the request IS issued (the sink counter moves),
 * but the blocked body must never be returned to the caller.
 */
vi.mock('../../../src/fetch/browser-request-guard.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/fetch/browser-request-guard.js')>(
    '../../../src/fetch/browser-request-guard.js',
  );
  return {
    ...actual,
    // Exactly what a non-Chromium engine gets back.
    installBrowserRequestGuard: async () => ({
      intercepting: false,
      blockedReason: () => null,
      dispose: async () => {},
    }),
  };
});

const { MultiBrowserPool } = await import('../../../src/fetch/browser-pool.js');

async function listen(server: Server, host: string): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => resolve());
  });
  const addr = server.address();
  if (typeof addr !== 'object' || addr === null) throw new Error('no address');
  return addr.port;
}

describe('browser tier post-navigation backstop (no per-hop interceptor)', () => {
  let pool: InstanceType<typeof MultiBrowserPool> | null = null;
  let sinkServer: Server | null = null;
  let allowedServer: Server | null = null;
  let origin: Server | null = null;
  let originPort = 0;
  const sinkHits: string[] = [];
  let usable = false;

  beforeAll(async () => {
    try {
      sinkServer = createServer((req, res) => {
        sinkHits.push(req.url ?? '');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<html><body><h1>SINK BODY</h1><p>${'x'.repeat(2000)}</p></body></html>`);
      });
      const sinkPort = await listen(sinkServer, '0.0.0.0');

      allowedServer = createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<html><body><h1>ALLOWED BODY</h1><p>${'y'.repeat(2000)}</p></body></html>`);
      });
      const allowedPort = await listen(allowedServer, '127.0.0.1');

      origin = createServer((req, res) => {
        const routes: Record<string, string> = {
          '/r1': `http://0.0.0.0:${sinkPort}/pwned`,
          '/r2': `http://127.0.0.1:${allowedPort}/landing`,
        };
        const location = routes[req.url ?? ''];
        if (!location) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(302, { location });
        res.end();
      });
      originPort = await listen(origin, '127.0.0.1');

      pool = new MultiBrowserPool();
      usable = true;
    } catch {
      usable = false;
    }
  }, 90_000);

  afterAll(async () => {
    await pool?.shutdown().catch(() => {});
    for (const s of [sinkServer, allowedServer, origin]) {
      if (s) await new Promise<void>((r) => s.close(() => r()));
    }
  });

  it('refuses the blocked body even with no interceptor — the engine-independent guarantee', async () => {
    if (!usable || !pool) {
      console.warn('local bind or browser launch unavailable here; CI exercises this for real');
      return;
    }
    sinkHits.length = 0;

    // THE security property, asserted first and on its own: the blocked body is
    // never returned to the caller. Resolving at all is the failure — deleting the
    // post-navigation `assertNavigationChainAllowed` from browser-pool.ts makes this
    // call resolve with SINK BODY, which is the mutation this file exists to kill.
    const err = await pool.fetchWithBrowser(`http://127.0.0.1:${originPort}/r1`).then(
      (r) => {
        throw new Error(
          `SECURITY: the blocked redirect target returned a body instead of refusing: ${String(r.html).slice(0, 120)}`,
        );
      },
      (e: unknown) => e,
    );
    const message = err instanceof Error ? err.message : String(err);

    // Attribution, which is platform-dependent and is NOT the security property.
    // Two refusal paths both satisfy the guarantee:
    //   - wigolo's own backstop re-guards the navigation chain after the fact;
    //   - the browser engine declines to route 0.0.0.0 at all, before wigolo sees
    //     the hop (observed on windows-latest as net::ERR_ADDRESS_INVALID).
    // Accepting either keeps the test honest cross-platform; accepting ANY rejection
    // would not, because a timeout or a crash would then read as a refusal.
    const byBackstop = /unspecified IPv4 \(0\.0\.0\.0\)/i.test(message);
    const byEngine = /net::ERR_ADDRESS_(?:INVALID|UNREACHABLE)/i.test(message);
    expect(
      byBackstop || byEngine,
      `refused, but for an unrecognised reason — neither wigolo's backstop nor an engine address refusal: ${message}`,
    ).toBe(true);

    // Asserted, not glossed, and correlated with WHICH path refused. Through the
    // backstop the request DOES go out first — the honest ceiling of the
    // firefox/webkit path, and why the interceptor exists on Chromium rather than
    // this check being the whole fence. When the engine refuses the address up
    // front, nothing is ever sent, so demanding a sink hit there would assert the
    // absence of a stronger outcome.
    expect(sinkHits).toEqual(byBackstop ? ['/pwned'] : []);
    if (!byBackstop) {
      console.warn(
        'the browser engine refused 0.0.0.0 before wigolo\'s backstop was reached; ' +
          'the refusal holds but the BACKSTOP itself is not exercised on this platform',
      );
    }
  }, 90_000);

  it('still returns an allowed redirect target, so the backstop is not a blanket refusal', async () => {
    if (!usable || !pool) {
      console.warn('local bind or browser launch unavailable here; CI exercises this for real');
      return;
    }
    const result = await pool.fetchWithBrowser(`http://127.0.0.1:${originPort}/r2`);
    expect(result.html).toContain('ALLOWED BODY');
  }, 90_000);
});
