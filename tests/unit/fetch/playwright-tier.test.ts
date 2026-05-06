import { describe, it, expect, vi } from 'vitest';
import { detectPlaywrightInstall, shouldEscalate } from '../../../src/fetch/playwright-tier.js';

describe('shouldEscalate', () => {
  it('escalates when body is shorter than 500 chars', () => {
    expect(shouldEscalate('short body')).toBe(true);
  });
  it('escalates when body contains "enable JavaScript"', () => {
    const body = 'x'.repeat(2000) + ' please enable JavaScript to view this site';
    expect(shouldEscalate(body)).toBe(true);
  });
  it('does not escalate substantial English content', () => {
    expect(shouldEscalate('a'.repeat(2000))).toBe(false);
  });
});

describe('detectPlaywrightInstall', () => {
  it('returns { installed: boolean } without throwing', async () => {
    const r = await detectPlaywrightInstall();
    expect(typeof r.installed).toBe('boolean');
    if (!r.installed) expect(r.hint).toMatch(/playwright install/);
  });
});

describe('getDaemonBrowser race safety', () => {
  it('coalesces concurrent calls into a single launch', async () => {
    const { getDaemonBrowser, closeDaemonBrowser } = await import('../../../src/fetch/playwright-tier.js');
    await closeDaemonBrowser();
    const [a, b] = await Promise.allSettled([getDaemonBrowser(), getDaemonBrowser()]);
    if (a.status === 'fulfilled' && b.status === 'fulfilled') {
      expect(a.value).toBe(b.value);
    } else if (a.status === 'rejected' && b.status === 'rejected') {
      expect((a.reason as Error).message).toBe('playwright_not_installed');
      expect((b.reason as Error).message).toBe('playwright_not_installed');
    } else {
      throw new Error('inconsistent settlement: one fulfilled, one rejected — race not coalesced');
    }
    await closeDaemonBrowser();
  });
});
