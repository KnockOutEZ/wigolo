import { createServer, type Server } from 'node:http';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MultiBrowserPool } from '../../../src/fetch/browser-pool.js';

/**
 * WHY: the browser tier performed a PRE-NAVIGATION host check and nothing more,
 * so a 302 from an allowed origin onto a blocked one was followed and its
 * content returned. Reproduced at 54112441 with the arrangement below — the
 * sink's hit counter reached 1 and the fetch returned the sink's body.
 *
 * The assertion here is deliberately OUTCOME-based rather than message-based: a
 * real HTTP server stands at the blocked address and counts requests. A fence
 * that only changed an error string would leave that counter at 1. The positive
 * control in each blocking test proves the counter is wired and the sink is
 * live, so a zero cannot come from a dead server.
 *
 * `0.0.0.0` is the blocked address used for the sink because it is the one the
 * shared fence refuses (`guardFetchUrl`: unspecified IPv4) that can also be
 * bound and reached without elevated privileges — 169.254.169.254 and RFC1918
 * are covered by the refusal-shape tests below and by the unit-level parity
 * table in tests/unit/fetch/browser-request-guard.test.ts.
 */

interface Sink {
  server: Server;
  port: number;
  hits: string[];
}

async function listen(server: Server, host: string): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => resolve());
  });
  const addr = server.address();
  if (typeof addr !== 'object' || addr === null) throw new Error('no address');
  return addr.port;
}

describe('browser tier re-guards every redirect hop', () => {
  let pool: MultiBrowserPool | null = null;
  let sink: Sink | null = null;
  let origin: Server | null = null;
  let originPort = 0;
  let publicTarget: Sink | null = null;
  let usable = false;

  beforeAll(async () => {
    try {
      const sinkHits: string[] = [];
      const sinkServer = createServer((req, res) => {
        sinkHits.push(req.url ?? '');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<html><body><h1>SINK BODY</h1><p>${'x'.repeat(2000)}</p></body></html>`);
      });
      const sinkPort = await listen(sinkServer, '0.0.0.0');
      sink = { server: sinkServer, port: sinkPort, hits: sinkHits };

      const targetHits: string[] = [];
      const targetServer = createServer((req, res) => {
        targetHits.push(req.url ?? '');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<html><body><h1>ALLOWED BODY</h1><p>${'y'.repeat(2000)}</p></body></html>`);
      });
      const targetPort = await listen(targetServer, '127.0.0.1');
      publicTarget = { server: targetServer, port: targetPort, hits: targetHits };

      origin = createServer((req, res) => {
        // Route names are deliberately opaque. A descriptive name like
        // "/to-metadata" appears verbatim in Chromium's own navigation error
        // text, so a message-matching assertion would pass against UNFENCED
        // code purely because the request URL echoed the word — a vacuous
        // green. Measured: with "/to-metadata" this suite showed 2 reds at
        // base instead of 3.
        const routes: Record<string, string> = {
          '/r1': `http://0.0.0.0:${sinkPort}/pwned`,
          '/r2': '/r3',
          '/r3': `http://0.0.0.0:${sinkPort}/pwned`,
          '/r4': 'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
          '/r5': 'http://10.0.0.1/admin',
          '/r6': `http://127.0.0.1:${targetPort}/landing`,
        };
        const location = routes[req.url ?? ''];
        if (location) {
          res.writeHead(302, { location });
          res.end();
          return;
        }
        if (req.url === '/plain') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(`<html><body><h1>PLAIN BODY</h1><p>${'z'.repeat(2000)}</p></body></html>`);
          return;
        }
        res.writeHead(404);
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
    for (const s of [sink?.server, publicTarget?.server, origin]) {
      if (s) await new Promise<void>((r) => s.close(() => r()));
    }
  });

  it('does not reach a blocked host a 302 points it at — the sink is never hit', async () => {
    if (!usable || !pool || !sink) {
      console.warn('local bind or browser launch unavailable here; CI exercises this for real');
      return;
    }
    // Positive control: the sink is live and its counter is wired. Without
    // this, a zero below would be indistinguishable from a dead server.
    await fetch(`http://0.0.0.0:${sink.port}/control`).then((r) => r.text());
    expect(sink.hits).toEqual(['/control']);
    sink.hits.length = 0;

    await expect(pool.fetchWithBrowser(`http://127.0.0.1:${originPort}/r1`)).rejects.toThrow(
      /Blocked by SSRF policy on a browser redirect hop.*unspecified IPv4/is,
    );
    expect(sink.hits).toEqual([]);
  }, 90_000);

  it('re-guards the LAST hop of a multi-hop chain, not just the first', async () => {
    if (!usable || !pool || !sink) {
      console.warn('local bind or browser launch unavailable here; CI exercises this for real');
      return;
    }
    await fetch(`http://0.0.0.0:${sink.port}/control`).then((r) => r.text());
    expect(sink.hits.length).toBe(1);
    sink.hits.length = 0;

    // /r2 -> /r3 (both allowed) -> the sink. A first-hop-only check passes
    // this chain; only a per-hop re-guard refuses it.
    await expect(pool.fetchWithBrowser(`http://127.0.0.1:${originPort}/r2`)).rejects.toThrow(
      /Blocked by SSRF policy on a browser redirect hop.*unspecified IPv4/is,
    );
    expect(sink.hits).toEqual([]);
  }, 90_000);

  it('refuses a redirect onto the cloud-metadata endpoint', async () => {
    if (!usable || !pool) {
      console.warn('local bind or browser launch unavailable here; CI exercises this for real');
      return;
    }
    await expect(pool.fetchWithBrowser(`http://127.0.0.1:${originPort}/r4`)).rejects.toThrow(
      /Blocked by SSRF policy on a browser redirect hop.*link-local IPv4 \(169\.254\.169\.254\)/is,
    );
  }, 90_000);

  it('refuses a redirect onto an RFC1918 address', async () => {
    if (!usable || !pool) {
      console.warn('local bind or browser launch unavailable here; CI exercises this for real');
      return;
    }
    await expect(pool.fetchWithBrowser(`http://127.0.0.1:${originPort}/r5`)).rejects.toThrow(
      /Blocked by SSRF policy on a browser redirect hop.*private IPv4 \(10\.0\.0\.1, 10\/8\)/is,
    );
  }, 90_000);

  it('still follows a redirect to an allowed host and returns its body', async () => {
    // Must-not-fire. A fence that blocks everything passes every test above.
    if (!usable || !pool || !publicTarget) {
      console.warn('local bind or browser launch unavailable here; CI exercises this for real');
      return;
    }
    publicTarget.hits.length = 0;
    const result = await pool.fetchWithBrowser(`http://127.0.0.1:${originPort}/r6`);
    expect(result.html).toContain('ALLOWED BODY');
    expect(result.finalUrl).toContain('/landing');
    expect(publicTarget.hits).toEqual(['/landing']);
  }, 90_000);

  it('still serves an ordinary single-hop page load unchanged', async () => {
    if (!usable || !pool) {
      console.warn('local bind or browser launch unavailable here; CI exercises this for real');
      return;
    }
    const result = await pool.fetchWithBrowser(`http://127.0.0.1:${originPort}/plain`);
    expect(result.html).toContain('PLAIN BODY');
    expect(result.statusCode).toBe(200);
  }, 90_000);
});
