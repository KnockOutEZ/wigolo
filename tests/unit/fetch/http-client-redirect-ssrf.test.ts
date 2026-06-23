import { describe, it, expect, vi, afterEach } from 'vitest';
import { httpFetch } from '../../../src/fetch/http-client.js';

// http-client follows redirects with `redirect: 'manual'`, reading the Location header and
// re-requesting. The PAGE chooses the redirect target, so each hop is re-validated as AGENT-source
// (P6-a): a public URL that 30x-redirects to cloud-metadata / RFC1918 is the classic SSRF-via-
// redirect bypass and must be blocked AT THE HOP, before the internal target is ever fetched.
// Loopback stays allowed (non-escalation), consistent with the content-path policy.

function redirectTo(location: string): Response {
  return new Response('', { status: 302, headers: { location } });
}
function ok(body = '<html><body>landing</body></html>'): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
}

afterEach(() => vi.unstubAllGlobals());

describe('httpFetch — redirect hops re-validated against SSRF (P6-a exfil leg)', () => {
  it('blocks a 30x redirect to cloud-metadata at the hop — the internal target is NEVER fetched', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(redirectTo('http://169.254.169.254/latest/meta-data/'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(httpFetch('https://public.example/start')).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1); // only the public start URL — the metadata target was never requested
  });

  it('blocks a 30x redirect to an RFC1918 address at the hop', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(redirectTo('http://10.0.0.5/admin'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(httpFetch('https://public.example/start')).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('ALLOWS a 30x redirect to localhost (non-escalation, consistent with the content-path policy)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(redirectTo('http://127.0.0.1:9999/landing'))
      .mockResolvedValueOnce(ok());
    vi.stubGlobal('fetch', fetchMock);
    const r = await httpFetch('https://public.example/start');
    expect(r.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2); // followed the localhost hop
  });

  it('a public→public redirect still follows normally', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(redirectTo('https://other.example/landing'))
      .mockResolvedValueOnce(ok());
    vi.stubGlobal('fetch', fetchMock);
    const r = await httpFetch('https://public.example/start');
    expect(r.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
