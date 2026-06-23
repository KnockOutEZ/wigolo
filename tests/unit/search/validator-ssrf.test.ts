import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { validateLinks } from '../../../src/search/validator.js';
import { resetConfig } from '../../../src/config.js';

// R1 SEAL: validateLinks HEAD-probes discovered result URLs. Before the fix it did so with NO SSRF
// guard and `redirect:'follow'` — a blind/recon SSRF + metadata-via-redirect bypass. The fix guards
// each URL (agent-source content-path matrix: block metadata/link-local + RFC1918; allow loopback)
// and switches to `redirect:'manual'` (a 3xx is treated as reachable, never auto-followed). Pins
// enter through the real validateLinks; the network primitive is spied so a blocked target proves it
// was never fetched.

const originalEnv = process.env;

beforeEach(() => {
  process.env = { ...originalEnv, VALIDATE_LINKS: 'true', VALIDATE_TIMEOUT_MS: '1000' };
  resetConfig();
});
afterEach(() => {
  vi.unstubAllGlobals();
  process.env = originalEnv;
  resetConfig();
});

describe('validateLinks — SSRF guard on discovered URLs (R1 seal)', () => {
  it('(a) drops an agent-reached RFC1918 URL and NEVER fires the HEAD probe', async () => {
    const fetchSpy = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const valid = await validateLinks([{ url: 'http://10.0.0.5/admin', title: 'x' }]);
    expect(valid).toHaveLength(0); // dropped
    expect(fetchSpy).not.toHaveBeenCalled(); // internal target never probed
  });

  it('(b) drops cloud-metadata (169.254.169.254) and NEVER fires the HEAD probe', async () => {
    const fetchSpy = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const valid = await validateLinks([{ url: 'http://169.254.169.254/latest/meta-data/', title: 'x' }]);
    expect(valid).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('(c) ALLOWS a loopback URL — the HEAD probe fires (no over-block)', async () => {
    const fetchSpy = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const valid = await validateLinks([{ url: 'http://127.0.0.1:9999/health', title: 'x' }]);
    expect(valid).toHaveLength(1); // reachable, kept
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('validateLinks — redirects are NOT followed (redirect:manual, R1 seal)', () => {
  let server: Server;
  let port: number;
  let destHits = 0;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { location: `http://127.0.0.1:${port}/dest` });
        res.end();
      } else if (req.url === '/dest') {
        destHits++;
        res.writeHead(200);
        res.end();
      } else {
        res.writeHead(200);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => { port = (server.address() as { port: number }).port; resolve(); }));
  });
  afterAll(() => { server.close(); });

  it('(d) a 30x redirect destination is NEVER fetched (the hop is not auto-followed)', async () => {
    destHits = 0;
    const valid = await validateLinks([{ url: `http://127.0.0.1:${port}/start`, title: 'x' }]);
    expect(destHits).toBe(0); // /dest (the redirect target) was never requested
    expect(valid).toHaveLength(1); // the 3xx itself is treated as reachable (status < 400)
  });
});
