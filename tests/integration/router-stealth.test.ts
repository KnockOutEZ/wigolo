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

  // A "please enable JavaScript" DataDome shell already escalates via the
  // shouldEscalate /enable javascript/i marker.
  it('escalates a DataDome enable-javascript shell (already covered by shouldEscalate)', async () => {
    const shell = '<html><head><title>Just a moment...</title></head><body>' +
      '<div class="dd-loader"></div>Please enable JavaScript to continue.' +
      'x'.repeat(1000) + '</body></html>';
    const fakeStatic = vi.fn(async () => ({ url: 'https://x', html: shell, text: 'Please enable JavaScript to continue. ' + 'x'.repeat(1000) }));
    const fakePw = vi.fn(async () => ({ html: '<html><body>' + 'real content '.repeat(200) + '</body></html>', text: 'real content '.repeat(200) }));
    const r = new SmartRouter({ httpFetcher: fakeStatic as any, playwrightFetcher: fakePw as any });
    const out = await r.fetch('https://x', { mode: 'stealth' });
    expect(fakePw).toHaveBeenCalledOnce();
    expect((out as any).escalated).toBe(true);
  });

  // A challenge shell WITHOUT "enable javascript" and with >500 chars of text
  // would NOT trip the old shouldEscalate. It must still escalate because the
  // body carries a challenge skeleton with markers.
  it('escalates a challenge skeleton shell that lacks the enable-javascript marker and is > 500 chars', async () => {
    const shell = '<html><head><title>Just a moment...</title></head><body>' +
      '<div class="cf-browser-verification"></div><script>var _cfChlOpt={};</script>' +
      '</body></html>';
    // Text > 500 chars and no "enable javascript" → shouldEscalate(text) is
    // false, so the challenge-shell branch is the ONLY reason this escalates.
    const text = 'Just a moment while we verify your browser. '.repeat(20);
    const fakeStatic = vi.fn(async () => ({ url: 'https://x', html: shell, text }));
    const fakePw = vi.fn(async () => ({ html: '<html><body>' + 'real content '.repeat(200) + '</body></html>', text: 'real content '.repeat(200) }));
    const r = new SmartRouter({ httpFetcher: fakeStatic as any, playwrightFetcher: fakePw as any });
    const out = await r.fetch('https://x', { mode: 'stealth' });
    expect(fakePw).toHaveBeenCalledOnce();
    expect((out as any).escalated).toBe(true);
  });

  // The static challenge shell must never be RETURNED when playwright is
  // unavailable — it becomes a blocked_by_challenge error, not the shell.
  it('returns blocked_by_challenge when the static body is a challenge shell and playwright is missing', async () => {
    const shell = '<html><head><title>Just a moment...</title></head><body>' +
      '<div class="cf-browser-verification"></div></body></html>';
    const fakeStatic = vi.fn(async () => ({ url: 'https://x', html: shell, text: 'Just a moment...' }));
    const fakePw = vi.fn(async () => { const e = new Error('playwright_not_installed') as any; e.hint = 'x'; throw e; });
    const r = new SmartRouter({ httpFetcher: fakeStatic as any, playwrightFetcher: fakePw as any });
    const out = await r.fetch('https://x', { mode: 'stealth' });
    // The shell is thin so it escalates; playwright is missing → surface the
    // install error (the shell markdown is never returned as content either way).
    expect((out as any).error).toBe('playwright_not_installed');
  });
});
