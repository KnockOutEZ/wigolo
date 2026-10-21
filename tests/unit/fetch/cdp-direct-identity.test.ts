import { describe, it, expect } from 'vitest';
import { coherentIdentity } from '../../../src/fetch/cdp-direct.js';

// WHY: headless Chrome differs from headful in three server-visible ways (the
// HeadlessChrome UA token, the full-vs-reduced UA version + HeadlessChrome
// sec-ch-ua brand, and devicePixelRatio 1 on a HiDPI host). They must be fixed
// TOGETHER and derived from the binary's OWN reported UA — detectors score
// cross-layer CONTRADICTIONS, so a partial fix is worse than none. Measured
// 2026-07-28: a hardened headless Chrome returned the same 3,170 chars of real
// content as headful on a PerimeterX-protected target.
const HEADLESS_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/150.0.7871.187 Safari/537.36';

describe('coherentIdentity', () => {
  it('strips the HeadlessChrome token and reduces the UA version like headful does', () => {
    const id = coherentIdentity(HEADLESS_MAC, 'darwin')!;
    expect(id.userAgent).not.toContain('Headless');
    // Headful sends major.0.0.0; headless leaks the full build.
    expect(id.userAgent).toContain('Chrome/150.0.0.0');
    expect(id.userAgent).not.toContain('150.0.7871.187');
  });

  it('keeps UA major, brand major and fullVersion major in agreement (no contradiction)', () => {
    const id = coherentIdentity(HEADLESS_MAC, 'darwin')!;
    const chromium = id.userAgentMetadata.brands.find((b) => b.brand === 'Chromium');
    const chrome = id.userAgentMetadata.brands.find((b) => b.brand === 'Google Chrome');
    expect(chromium?.version).toBe('150');
    expect(chrome?.version).toBe('150');
    expect(id.userAgentMetadata.fullVersion.startsWith('150.')).toBe(true);
    // No brand may advertise headlessness.
    expect(id.userAgentMetadata.brands.some((b) => /headless/i.test(b.brand))).toBe(false);
  });

  it('derives everything from the SUPPLIED ua so it cannot drift from the real binary', () => {
    // A different major in => that major out, with nothing pinned.
    const id = coherentIdentity(HEADLESS_MAC.replace(/150\./g, '162.'), 'darwin')!;
    expect(id.userAgent).toContain('Chrome/162.0.0.0');
    expect(id.userAgentMetadata.brands.find((b) => b.brand === 'Chromium')?.version).toBe('162');
  });

  it('reports a platform-plausible devicePixelRatio (HiDPI on mac, 1 on a linux server)', () => {
    // A real GPU renderer string next to dpr 1 on a Retina host is the
    // contradiction being removed (measured: headful 2, headless 1, same Mac).
    expect(coherentIdentity(HEADLESS_MAC, 'darwin')!.deviceScaleFactor).toBe(2);
    expect(coherentIdentity(HEADLESS_MAC, 'linux')!.deviceScaleFactor).toBe(1);
  });

  it('maps platform coherently (UA platform must not contradict the host)', () => {
    expect(coherentIdentity(HEADLESS_MAC, 'darwin')!.userAgentMetadata.platform).toBe('macOS');
    expect(coherentIdentity(HEADLESS_MAC, 'linux')!.userAgentMetadata.platform).toBe('Linux');
    expect(coherentIdentity(HEADLESS_MAC, 'linux')!.platform).toBe('Linux x86_64');
  });

  it('returns null on an unparseable user agent rather than inventing an identity', () => {
    // Fail closed: no version means no coherent story to tell, so the caller
    // leaves the browser's own identity alone instead of fabricating one.
    expect(coherentIdentity('not-a-user-agent', 'darwin')).toBeNull();
    expect(coherentIdentity('', 'darwin')).toBeNull();
  });
});
