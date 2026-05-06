import { describe, it, expect, vi } from 'vitest';
import { SmartRouter } from '../../src/fetch/router.js';

describe('SmartRouter stealth mode', () => {
  it('escalates to Playwright when static fetch returns < 500 chars', async () => {
    const fakeStatic = vi.fn(async () => ({ url: 'https://x', html: '<html></html>', text: 'tiny' }));
    const fakePw = vi.fn(async () => ({ html: '<html><body>'.padEnd(2000, 'x') + '</body></html>', text: 'x'.repeat(2000) }));
    const r = new SmartRouter({ httpFetcher: fakeStatic as any, playwrightFetcher: fakePw as any });
    const out = await r.fetch('https://x', { mode: 'stealth' });
    expect(fakePw).toHaveBeenCalledOnce();
    expect((out as any).escalated).toBe(true);
  });

  it('returns playwright_not_installed StageError when stealth requested but missing', async () => {
    const fakeStatic = vi.fn(async () => ({ url: 'https://x', html: '<html></html>', text: 'tiny' }));
    const fakePw = vi.fn(async () => { const e = new Error('playwright_not_installed') as any; e.hint = 'npx playwright install chromium'; throw e; });
    const r = new SmartRouter({ httpFetcher: fakeStatic as any, playwrightFetcher: fakePw as any });
    const out = await r.fetch('https://x', { mode: 'stealth' });
    expect((out as any).error).toBe('playwright_not_installed');
    expect((out as any).hint).toMatch(/playwright install/);
  });

  it('does NOT escalate when static body is substantial (shouldEscalate=false)', async () => {
    const fakeStatic = vi.fn(async () => ({
      url: 'https://x',
      html: '<html><body>' + 'a'.repeat(2000) + '</body></html>',
      text: 'a'.repeat(2000),
    }));
    const fakePw = vi.fn(async () => ({ html: 'should-not-be-called', text: 'should-not-be-called' }));
    const r = new SmartRouter({ httpFetcher: fakeStatic as any, playwrightFetcher: fakePw as any });
    const out = await r.fetch('https://x', { mode: 'stealth' });
    expect(fakePw).not.toHaveBeenCalled();
    expect((out as any).escalated).toBeUndefined();
  });

  it('returns playwright_fetch_failed StageError when playwright throws non-install error', async () => {
    const fakeStatic = vi.fn(async () => ({ url: 'https://x', html: '<html></html>', text: 'tiny' }));
    const fakePw = vi.fn(async () => { throw new Error('navigation_timeout'); });
    const r = new SmartRouter({ httpFetcher: fakeStatic as any, playwrightFetcher: fakePw as any });
    const out = await r.fetch('https://x', { mode: 'stealth' });
    expect((out as any).error).toBe('playwright_fetch_failed');
    expect((out as any).stage).toBe('fetch');
    expect((out as any).error_reason).toMatch(/navigation_timeout/);
  });
});
