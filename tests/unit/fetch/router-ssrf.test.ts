import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resetConfig } from '../../../src/config.js';

vi.mock('../../../src/fetch/auth.js', () => ({ getAuthOptions: vi.fn(async () => null) }));

import { SmartRouter } from '../../../src/fetch/router.js';
import type { HttpClient, BrowserPoolInterface } from '../../../src/fetch/router.js';

// Long enough to clear the empty-content check so a non-blocked fetch resolves cleanly.
const HTML = `<html><body><p>${'real content here '.repeat(20)}</p></body></html>`;

function httpResult() {
  return { url: 'http://x', finalUrl: 'http://x', html: HTML, contentType: 'text/html', statusCode: 200, headers: {} };
}

describe('SmartRouter.fetch — source-aware SSRF navigation guard (P6-a exfil leg)', () => {
  let httpClient: HttpClient;
  let browserPool: BrowserPoolInterface;
  let router: SmartRouter;

  beforeEach(() => {
    resetConfig();
    httpClient = { fetch: vi.fn(async () => httpResult()) };
    browserPool = { fetchWithBrowser: vi.fn(async () => ({ ...httpResult(), method: 'playwright' as const })) };
    router = new SmartRouter(httpClient, browserPool);
  });

  it('agent-sourced fetch to cloud-metadata is blocked BEFORE the network (no fetcher call)', async () => {
    const r = await router.fetch('http://169.254.169.254/latest/meta-data/', { source: 'agent' });
    expect('error' in r && r.error).toBe('navigation_blocked');
    expect(httpClient.fetch).not.toHaveBeenCalled();
    expect(browserPool.fetchWithBrowser).not.toHaveBeenCalled();
  });

  it('agent-sourced fetch to an RFC1918 private address is blocked by default', async () => {
    const r = await router.fetch('http://10.0.0.5/admin', { source: 'agent' });
    expect('error' in r && r.error).toBe('navigation_blocked');
    expect(httpClient.fetch).not.toHaveBeenCalled();
  });

  it('agent-sourced fetch to localhost is ALLOWED (refined: loopback reachable by both parties)', async () => {
    const r = await router.fetch('http://localhost:3000/', { source: 'agent' });
    expect('error' in r).toBe(false);
    expect(httpClient.fetch).toHaveBeenCalledTimes(1);
  });

  it('human-sourced fetch to localhost is ALLOWED (co-browse a local dev server)', async () => {
    const r = await router.fetch('http://localhost:3000/', { source: 'human' });
    expect('error' in r).toBe(false);
    expect(httpClient.fetch).toHaveBeenCalledTimes(1);
  });

  it('human-sourced fetch to RFC1918 is ALLOWED (human may reach private networks)', async () => {
    const r = await router.fetch('http://10.0.0.5/', { source: 'human' });
    expect('error' in r).toBe(false);
    expect(httpClient.fetch).toHaveBeenCalledTimes(1);
  });

  it('cloud-metadata is blocked even for a human (never reachable, before the privacy flag)', async () => {
    const r = await router.fetch('http://169.254.169.254/', { source: 'human' });
    expect('error' in r && r.error).toBe('navigation_blocked');
    expect(httpClient.fetch).not.toHaveBeenCalled();
  });

  it('public URLs are unaffected (agent, default behavior)', async () => {
    const r = await router.fetch('https://example.com/page', { source: 'agent' });
    expect('error' in r).toBe(false);
    expect(httpClient.fetch).toHaveBeenCalledTimes(1);
  });

  it('source defaults to agent (fail-closed) — a private target is blocked when source is omitted', async () => {
    const r = await router.fetch('http://192.168.1.1/');
    expect('error' in r && r.error).toBe('navigation_blocked');
    expect(httpClient.fetch).not.toHaveBeenCalled();
  });
});
