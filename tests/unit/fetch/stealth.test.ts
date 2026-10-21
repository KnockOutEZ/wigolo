import { describe, it, expect } from 'vitest';
import {
  resolveStealthUA,
  stealthLaunchArgs,
  stealthContextOptions,
  parseChromeMajor,
  isSwiftShaderRenderer,
  STEALTH_INIT_SCRIPT,
  STEALTH_CHROME_MAJOR,
} from '../../../src/fetch/stealth.js';

describe('resolveStealthUA', () => {
  // The synthesized UA (fallback path only) MUST carry a platform token that
  // matches the ACTUAL runtime OS — a Windows token on a mac/Linux host is the
  // top cross-layer inconsistency a modern detector scores (UA says Windows,
  // navigator.platform says the real OS). Table-driven across the 3 platforms.
  it.each([
    ['darwin', 'Macintosh; Intel Mac OS X', 142],
    ['linux', 'X11; Linux x86_64', 130],
    ['win32', 'Windows NT 10.0; Win64; x64', 138],
  ] as const)(
    'for %s emits the matching platform token and the given Chrome major',
    (platform, token, major) => {
      const ua = resolveStealthUA(platform, major);
      expect(ua).toContain(token);
      expect(ua).toContain(`Chrome/${major}.`);
      expect(ua).toMatch(/^Mozilla\/5\.0 /);
      expect(ua).toContain('Safari/537.36');
      expect(ua).not.toContain('Mobile');
    },
  );

  it('NEVER emits a UA containing the HeadlessChrome token', () => {
    // A "HeadlessChrome" token is an unconditional automation tell; the
    // synthesized UA must never carry it regardless of platform/major.
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      expect(resolveStealthUA(platform, 142)).not.toContain('HeadlessChrome');
    }
  });

  it('falls back to the pinned Chrome major when none is given', () => {
    // No major → the shared TLS-tier pin, so browser + TLS still present one
    // Chrome identity for clearance reuse.
    const ua = resolveStealthUA('darwin');
    expect(ua).toContain(`Chrome/${STEALTH_CHROME_MAJOR}.`);
    expect(STEALTH_CHROME_MAJOR).toBe(142);
  });

  it('defaults to the runtime OS platform token when none is given', () => {
    const ua = resolveStealthUA();
    const expected =
      process.platform === 'darwin'
        ? 'Macintosh; Intel Mac OS X'
        : process.platform === 'win32'
          ? 'Windows NT 10.0; Win64; x64'
          : 'X11; Linux x86_64';
    expect(ua).toContain(expected);
  });
});

describe('parseChromeMajor', () => {
  it('extracts the leading major from a Playwright version string', () => {
    expect(parseChromeMajor('142.0.7444.0')).toBe(142);
    expect(parseChromeMajor('130.0.0.0')).toBe(130);
    expect(parseChromeMajor('99')).toBe(99);
  });

  it('returns null for an unparseable version (caller falls back to the pin)', () => {
    expect(parseChromeMajor('')).toBeNull();
    expect(parseChromeMajor(undefined)).toBeNull();
    expect(parseChromeMajor(null)).toBeNull();
    expect(parseChromeMajor('nope')).toBeNull();
  });
});

describe('stealthLaunchArgs', () => {
  it('disables the automation-controlled blink feature for chromium', () => {
    const args = stealthLaunchArgs('chromium');
    expect(args).toContain('--disable-blink-features=AutomationControlled');
    // A consistent locale + window-size reduce trivial headless fingerprints.
    expect(args.some((a) => a.startsWith('--window-size='))).toBe(true);
    expect(args).toContain('--lang=en-US');
  });

  it('returns [] for non-chromium engines (args are chromium-specific)', () => {
    expect(stealthLaunchArgs('webkit')).toEqual([]);
    expect(stealthLaunchArgs('firefox')).toEqual([]);
  });

  it('routes WebGL through ANGLE so a real GPU renderer is exposed rather than the obvious-headless SwiftShader tell', () => {
    // A windowless-headless chromium defaults its unmasked WebGL renderer to
    // "SwiftShader" — itself a high-signal automation fingerprint. Selecting the
    // ANGLE GL backend lets ANGLE pick the platform's real GPU renderer where
    // one exists (falling back to SwiftShader only on a genuinely GPU-less host,
    // where SwiftShader is the honest answer). Verified safe for headless paint:
    // layout, canvas, and screenshot bytes are byte-identical with these flags.
    const args = stealthLaunchArgs('chromium');
    expect(args).toContain('--use-gl=angle');
    expect(args).toContain('--enable-webgl');
    // Do NOT pin a specific ANGLE backend (e.g. swiftshader-webgl) — that would
    // FORCE SwiftShader and re-introduce the exact tell we are removing.
    expect(args.some((a) => a.includes('swiftshader'))).toBe(false);
  });
});

describe('isSwiftShaderRenderer', () => {
  it('flags a SwiftShader unmasked renderer string (the obvious-headless GL tell)', () => {
    expect(
      isSwiftShaderRenderer(
        'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (LLVM 10.0.0) (0x0000C0DE)), SwiftShader driver)',
      ),
    ).toBe(true);
    // Also matches the bare llvmpipe software rasterizer (Linux headless).
    expect(isSwiftShaderRenderer('Mesa/X.org llvmpipe (LLVM 15.0.0, 256 bits)')).toBe(true);
  });

  it('does NOT flag a plausible hardware GPU renderer', () => {
    expect(
      isSwiftShaderRenderer('ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Pro, Unspecified Version)'),
    ).toBe(false);
    expect(
      isSwiftShaderRenderer('ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Direct3D11 vs_5_0 ps_5_0, D3D11)'),
    ).toBe(false);
  });

  it('handles null / empty (unknown renderer is not flagged)', () => {
    expect(isSwiftShaderRenderer(null)).toBe(false);
    expect(isSwiftShaderRenderer('')).toBe(false);
    expect(isSwiftShaderRenderer(undefined)).toBe(false);
  });
});

describe('stealthContextOptions', () => {
  it('carries the UA, en-US locale, a US timezone, and a viewport', () => {
    const ua = resolveStealthUA();
    const opts = stealthContextOptions(ua);
    expect(opts.userAgent).toBe(ua);
    expect(opts.locale).toBe('en-US');
    expect(opts.timezoneId).toBe('America/New_York');
    expect(opts.viewport).toMatchObject({
      width: expect.any(Number),
      height: expect.any(Number),
    });
    // The pooled path passes acceptDownloads:true; the dedicated stealth
    // context must preserve that so a PDF response is still buffered.
    expect(opts.acceptDownloads).toBe(true);
  });

  it('OMITS userAgent when ua is undefined so the browser native UA stands', () => {
    // A real headed / new-headless browser presents a coherent native UA;
    // overriding it would re-introduce the very mismatch this path avoids.
    const opts = stealthContextOptions(undefined);
    expect('userAgent' in opts).toBe(false);
    expect(opts.locale).toBe('en-US');
    expect(opts.acceptDownloads).toBe(true);
  });

  it('merges caller overrides without dropping the stealth defaults', () => {
    const ua = resolveStealthUA();
    const opts = stealthContextOptions(ua, { storageState: '/tmp/state.json' });
    expect(opts.storageState).toBe('/tmp/state.json');
    expect(opts.userAgent).toBe(ua);
    expect(opts.locale).toBe('en-US');
  });
});

describe('STEALTH_INIT_SCRIPT', () => {
  it('is syntactically valid JS that does not throw when evaluated', () => {
    // A real page runs it as a function body; compiling + calling it in a
    // stubbed navigator/window environment proves it neither has a syntax
    // error nor throws on load.
    const navigator: Record<string, unknown> = {
      permissions: { query: () => Promise.resolve({ state: 'granted' }) },
    };
    const win: Record<string, unknown> = {};
    const runner = new Function(
      'navigator',
      'window',
      'Notification',
      STEALTH_INIT_SCRIPT,
    );
    expect(() => runner(navigator, win, { permission: 'default' })).not.toThrow();
  });

  it('patches the highest-signal automation leaks', () => {
    expect(STEALTH_INIT_SCRIPT).toContain('webdriver');
    expect(STEALTH_INIT_SCRIPT).toContain('plugins');
    expect(STEALTH_INIT_SCRIPT).toContain('languages');
  });
});
