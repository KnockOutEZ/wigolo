import type { BrowserType } from '../types.js';

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
 */
export function stealthLaunchArgs(type: BrowserType): string[] {
  if (type !== 'chromium') return [];
  return [
    '--disable-blink-features=AutomationControlled',
    '--disable-features=IsolateOrigins,site-per-process',
    '--disable-infobars',
    `--window-size=${STEALTH_VIEWPORT.width},${STEALTH_VIEWPORT.height}`,
    '--lang=en-US',
  ];
}

/**
 * Options object for `browser.newContext(...)` on the dedicated stealth path.
 * A plain object usable directly as the newContext argument; caller overrides
 * (auth storage state, extra headers) merge on top without dropping the
 * stealth defaults. `acceptDownloads` mirrors the pooled path so a PDF response
 * is still buffered rather than turning into a hard navigation error.
 */
export function stealthContextOptions(
  ua: string,
  opts?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    userAgent: ua,
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
