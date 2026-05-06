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
});
