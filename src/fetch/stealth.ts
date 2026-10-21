import type { BrowserType as PwBrowserType } from 'playwright';
import type { BrowserType } from '../types.js';
import { createLogger } from '../logger.js';

const log = createLogger('fetch');

/**
 * Anti-bot fingerprint hardening for the dedicated browser-tier stealth path.
 *
 * Pure helpers (no browser-engine value import — types only) so they are
 * unit-testable without launching a real page. The browser tier consumes these
 * to build a DEDICATED per-fetch context whose fingerprint differs from the
 * pooled default, then closes it at end-of-fetch. All user-facing strings use
 * capability language — this module never leaks vendor internals.
 */

/**
 * Pinned Chrome desktop major version. Kept in ONE place so the TLS tier's
 * default browser profile (`chrome_142`) and this browser UA present a single,
 * coherent Chrome identity — a prerequisite for reusing a clearance cookie
 * across the two tiers. Bump BOTH together when the pin moves.
 */
export const STEALTH_CHROME_MAJOR = 142;

/**
 * The Chrome major the dedicated stealth path ACTUALLY launched this process,
 * or null before the first launch. The tier no longer advertises the pin: it
 * reads `browser.version()` and mints clearances under that real major (T1-C),
 * so the reuse gate has to compare against the same value or every clearance
 * minted on a machine whose Chrome differs from the pin is unreplayable.
 */
let launchedChromeMajor: number | null = null;

/** Record the major of the browser the stealth path just launched. `null`
 *  resets to the pin (used by tests and by a failed launch). */
export function recordLaunchedChromeMajor(major: number | null): void {
  launchedChromeMajor = major;
}

/** The Chrome major the browser tier will present: the real launched one when
 *  known, else the shared pin. */
export function currentStealthChromeMajor(): number {
  return launchedChromeMajor ?? STEALTH_CHROME_MAJOR;
}

/** Default desktop viewport for the dedicated stealth context. */
const STEALTH_VIEWPORT = { width: 1280, height: 800 } as const;

/**
 * The desktop OS platform token a Chrome desktop UA carries, keyed by Node's
 * `process.platform`. This MUST match the runtime OS: a synthesized UA whose
 * platform token contradicts the real `navigator.platform` /
 * `navigator.userAgentData` reported by the browser is the single highest-signal
 * cross-layer inconsistency modern detectors score. darwin→Macintosh,
 * linux→X11 Linux, win32→Windows. Anything else falls back to the Linux token
 * (the safest generic desktop identity for an unknown platform).
 */
function platformToken(platform: NodeJS.Platform | string): string {
  switch (platform) {
    case 'darwin':
      return 'Macintosh; Intel Mac OS X 10_15_7';
    case 'win32':
      return 'Windows NT 10.0; Win64; x64';
    default:
      return 'X11; Linux x86_64';
  }
}

/**
 * Synthesize a coherent modern Chrome desktop UA for the FALLBACK path only —
 * when a real browser's native UA is unavailable (e.g. a unit stub, or an
 * engine that does not expose one). The platform token matches the actual
 * runtime OS and the Chrome major matches the ACTUAL launched browser's major
 * version (read via `browser.version()` and passed here), so the advertised UA
 * never contradicts the runtime it runs on. Never emits a "HeadlessChrome"
 * token.
 *
 * @param platform Node `process.platform` (or an explicit value in tests);
 *   defaults to the current runtime OS.
 * @param major Chrome major version; defaults to the shared TLS-tier pin so the
 *   browser and TLS tiers still present one Chrome identity when the real major
 *   is unknown.
 */
export function resolveStealthUA(
  platform: NodeJS.Platform | string = process.platform,
  major: number = STEALTH_CHROME_MAJOR,
): string {
  return (
    `Mozilla/5.0 (${platformToken(platform)}) ` +
    'AppleWebKit/537.36 (KHTML, like Gecko) ' +
    `Chrome/${major}.0.0.0 Safari/537.36`
  );
}

/** Extract the major version from a browser `version()` string ("142.0.7444.0"
 * → 142). Returns null when the string carries no leading integer, so callers
 * fall back to the pinned major rather than an incoherent UA. */
export function parseChromeMajor(version: string | undefined | null): number | null {
  if (!version) return null;
  const m = /^(\d+)\./.exec(version.trim());
  if (m) return parseInt(m[1], 10);
  const n = parseInt(version.trim(), 10);
  return Number.isNaN(n) ? null : n;
}

/**
 * Chromium launch args that reduce trivial automation detection. Firefox and
 * WebKit take none of these flags — they are Chromium-specific — so return an
 * empty array for those engines. Chosen to be safe for headless rendering:
 * none of these disable the compositor or GPU paths that a page needs to lay
 * out and paint.
 *
 * WebGL/canvas coherence (T2-F): a windowless-headless chromium reports its
 * unmasked WebGL renderer as "Google SwiftShader" — a software rasterizer that
 * is itself a high-signal automation tell. We do NOT JS-spoof canvas/WebGL
 * (piecemeal spoofing de-coheres from the rest of the fingerprint and is
 * separately detected). Instead we select the ANGLE GL backend and let ANGLE
 * choose the platform's real GPU renderer where one exists — on an Apple/NVIDIA/
 * Intel GPU this yields a plausible `ANGLE (Apple, ... Metal Renderer ...)` style
 * string; on a genuinely GPU-less host it falls back to SwiftShader, which is
 * the honest answer there. Verified safe for headless rendering: layout, canvas
 * draw, and screenshot output are byte-identical with these flags on/off. We
 * deliberately do NOT pin `--use-angle=swiftshader-webgl` (that would force the
 * tell back in) and we do NOT `--disable-gpu` (that would kill the GL path).
 */
export function stealthLaunchArgs(type: BrowserType): string[] {
  if (type !== 'chromium') return [];
  return [
    '--disable-blink-features=AutomationControlled',
    '--disable-features=IsolateOrigins,site-per-process',
    '--disable-infobars',
    `--window-size=${STEALTH_VIEWPORT.width},${STEALTH_VIEWPORT.height}`,
    '--lang=en-US',
    // Route WebGL through ANGLE → real GPU renderer instead of SwiftShader.
    '--use-gl=angle',
    '--enable-webgl',
    // Some hosts blocklist the GPU for headless; without this ANGLE silently
    // reverts to SwiftShader on a machine that actually has a usable GPU.
    '--ignore-gpu-blocklist',
  ];
}

/**
 * Coherence self-check: does an unmasked WebGL renderer string look like a
 * software rasterizer (the obvious-headless GL tell)? Matches Chromium's
 * SwiftShader ("SwiftShader driver") and the Linux Mesa software path
 * ("llvmpipe"). Case-insensitive; a null/empty/unknown renderer is treated as
 * NOT-a-tell (we only flag a positive software-renderer signal, never guess).
 * Callers can log/flag when this fires so a residual SwiftShader fingerprint is
 * observable rather than silent.
 */
export function isSwiftShaderRenderer(renderer: string | null | undefined): boolean {
  if (!renderer) return false;
  const r = renderer.toLowerCase();
  return r.includes('swiftshader') || r.includes('llvmpipe');
}

/**
 * Options object for `browser.newContext(...)` on the dedicated stealth path.
 * A plain object usable directly as the newContext argument; caller overrides
 * (auth storage state, extra headers) merge on top without dropping the
 * stealth defaults. `acceptDownloads` mirrors the pooled path so a PDF response
 * is still buffered rather than turning into a hard navigation error.
 *
 * When `ua` is undefined the `userAgent` key is OMITTED so the launched
 * browser's NATIVE user agent stands — coherent by construction (correct
 * platform token + real Chrome major, no "HeadlessChrome" in the new headless
 * mode or a real installed browser). A synthesized UA is only passed on the
 * fallback path where the native UA is unavailable or must be pinned.
 */
export function stealthContextOptions(
  ua: string | undefined,
  opts?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...(ua !== undefined ? { userAgent: ua } : {}),
    locale: 'en-US',
    timezoneId: 'America/New_York',
    viewport: { ...STEALTH_VIEWPORT },
    acceptDownloads: true,
    extraHTTPHeaders: {
      'accept-language': 'en-US,en;q=0.9',
    },
    ...opts,
  };
}

/**
 * Page init script (run via `context.addInitScript`) patching the
 * highest-signal automation leaks: `navigator.webdriver`, a plausible
 * `navigator.plugins` / `navigator.languages`, a `window.chrome` runtime stub,
 * and `navigator.permissions.query` for the notifications quirk. Written as a
 * function body so it can be compiled and evaluated in tests; guards keep it
 * from throwing on a real page where some of these are already read-only.
 */
export const STEALTH_INIT_SCRIPT = `
try {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
} catch (e) { /* already patched or read-only */ }
try {
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
} catch (e) { /* ignore */ }
try {
  Object.defineProperty(navigator, 'plugins', {
    get: () => [
      { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
      { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
      { name: 'Native Client', filename: 'internal-nacl-plugin' },
    ],
  });
} catch (e) { /* ignore */ }
try {
  if (typeof window !== 'undefined' && !window.chrome) {
    window.chrome = { runtime: {} };
  }
} catch (e) { /* ignore */ }
try {
  if (navigator.permissions && navigator.permissions.query) {
    const originalQuery = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = (parameters) =>
      parameters && parameters.name === 'notifications'
        ? Promise.resolve({ state: (typeof Notification !== 'undefined' ? Notification.permission : 'default') })
        : originalQuery(parameters);
  }
} catch (e) { /* ignore */ }
`;

/**
 * Optional driver-level stealth launcher (T2-E).
 *
 * The dominant 2026 automation tell is the CDP `Runtime.enable` leak that the
 * standard browser driver emits. `patchright` is an optional, drop-in patched
 * driver that closes that leak at the driver level. It is a self-contained fork
 * (its own patched core + its own browser binary) that does NOT touch the pinned
 * standard browser driver, so it is safe as an OPTIONAL dependency: absent, we
 * fall back to the standard launcher and nothing breaks. Chromium-only — the
 * firefox/webkit engines never use it.
 *
 * Lazy-loaded on first use (mirrors the TLS tier's `wreq-js` pattern): the
 * module specifier is held as a `string` (not a literal) so `tsc --noEmit` does
 * not require the optional package to be installed, and the import is memoized
 * so the cost is paid at most once. `null` when the package is absent.
 */

/** The subset of the driver launcher we consume: a Playwright-shaped `launch`. */
export interface StealthDriverLauncher {
  launch(options?: Parameters<PwBrowserType['launch']>[0]): ReturnType<PwBrowserType['launch']>;
}

interface PatchrightModuleShape {
  chromium?: StealthDriverLauncher;
  default?: { chromium?: StealthDriverLauncher };
}

// Held as a non-literal string so the compiler skips module resolution — the
// package lives in optionalDependencies and may be absent (keyless installs,
// `npm install --omit=optional`, or a platform with no patched browser).
const PATCHRIGHT_MODULE_ID: string = 'patchright';

let _driverPromise: Promise<StealthDriverLauncher | null> | null = null;
let _driverCached: StealthDriverLauncher | null = null;
let _driverResolved = false;

/** Test-only override: bypass the real dynamic import. */
let _testDriverOverride: StealthDriverLauncher | null | undefined;
export function _setStealthDriverForTests(
  launcher: StealthDriverLauncher | null | undefined,
): void {
  _testDriverOverride = launcher;
  _driverPromise = null;
  _driverCached = null;
  _driverResolved = false;
}

/**
 * Resolve the optional driver-hardened chromium launcher, or `null` when it is
 * not installed. Never throws — an absent/broken optional package resolves to
 * `null` and the caller falls back to the standard launcher. Memoized: a
 * negative result is cached too, so a missing package is probed only once.
 */
export async function loadStealthDriver(): Promise<StealthDriverLauncher | null> {
  if (_testDriverOverride !== undefined) return _testDriverOverride;
  if (_driverResolved) return _driverCached;
  if (_driverPromise) return _driverPromise;
  _driverPromise = (async () => {
    try {
      const mod = (await import(PATCHRIGHT_MODULE_ID)) as PatchrightModuleShape;
      const chromium = mod.chromium ?? mod.default?.chromium;
      if (!chromium || typeof chromium.launch !== 'function') {
        log.debug('stealth driver present but missing a chromium launcher, falling back');
        _driverCached = null;
      } else {
        _driverCached = chromium;
        log.debug('driver-hardened stealth launcher available');
      }
    } catch {
      // Optional dep absent (or its browser not installed) — silent fallback.
      _driverCached = null;
    }
    _driverResolved = true;
    _driverPromise = null;
    return _driverCached;
  })();
  return _driverPromise;
}

/**
 * Pick the launcher for the dedicated stealth path given the resolved driver
 * mode and the standard fallback launcher. Chromium-only: for firefox/webkit,
 * or when the mode is `playwright`, or when the optional driver is absent, this
 * returns the standard `fallback` launcher unchanged. Only `auto`/`patchright`
 * on chromium WITH the optional driver present returns the hardened launcher.
 */
export async function resolveStealthLauncher(
  type: BrowserType,
  mode: 'auto' | 'patchright' | 'playwright',
  fallback: StealthDriverLauncher,
): Promise<StealthDriverLauncher> {
  if (type !== 'chromium' || mode === 'playwright') return fallback;
  const driver = await loadStealthDriver();
  return driver ?? fallback;
}
