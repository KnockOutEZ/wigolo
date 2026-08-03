/**
 * What the coherence class can and cannot assert IN CI, shared by both parity gates.
 *
 * The reference vector was captured from real Chrome 151 on macOS: 12/12 version-gated APIs and 6/6
 * codecs. Asserting those absolutes cross-platform was wrong, and CI proved it — on Linux the
 * substrate reports `BarcodeDetector: false` and `hev1: ''`. Neither is a defect and neither is a
 * regression: Chromium ships the Shape Detection API only on macOS and ChromeOS, and HEVC is a
 * licensing-dependent build flag. **Real Chrome on Linux answers the same way.** Spec §4 item 5
 * pre-settled exactly this disposition — measure it, state it, ship it as a ceiling.
 *
 * So the rule the coherence class actually encodes is "the surface matches the claimed major ON THIS
 * PLATFORM", not "matches the macOS vector". Checking that properly needs a real Chrome on the same
 * platform, which CI does not have. What CI can check, and what these buckets express:
 *
 *   1. the platform-independent surface is present — a claimed 150 missing `cookieStore` is a real
 *      contradiction on any OS;
 *   2. the platform-dependent surface is IDENTICAL across every arm — tab class and window state.
 *      That is the check with teeth here, because a difference between arms is something only this
 *      repo's own configuration can cause.
 *
 * The full same-platform comparison against real Chrome stays with the live macOS harness, where it
 * passed 12/12 and 6/6.
 */

/** Present on every desktop platform Chromium builds for. A gap here is a genuine contradiction. */
export const PLATFORM_INDEPENDENT_APIS = [
  'showOpenFilePicker',
  'scheduler',
  'documentPictureInPicture',
  'CSSPropertyRule',
  'cookieStore',
  'Notification',
] as const;

/**
 * Gated on platform or build flags, so their absolute value is not assertable cross-platform:
 * `BarcodeDetector` is macOS/ChromeOS-only; WebHID/WebUSB/Web Serial and view transitions vary with
 * the platform and the desktop environment. Recorded and compared across arms, never asserted absent
 * or present.
 */
export const PLATFORM_DEPENDENT_APIS = ['BarcodeDetector', 'ink', 'hid', 'usb', 'serial', 'ViewTransition'] as const;

/** Royalty-free or universally built into Chromium. `probably` on every platform. */
export const PLATFORM_INDEPENDENT_CODECS = ['avc1', 'vp9', 'mp4a', 'opus'] as const;

/**
 * Licensing/build-flag dependent. `hev1` (HEVC) is THE pre-settled ceiling: it is `probably` on the
 * macOS build and empty on the Linux one, and the only ways to close that would be to lie about
 * `canPlayType` or to lie about the claimed major — both forbidden. Compared across arms only.
 */
export const PLATFORM_DEPENDENT_CODECS = ['hev1', 'av01'] as const;

/**
 * OS-sandbox flags the direct-spawn harness needs on Linux CI, where the SUID sandbox helper is not
 * usable and `/dev/shm` is small. Playwright passes the equivalents for its own launches, which is
 * why the Playwright lane never needed them.
 *
 * These are HARNESS flags, not identity flags: no page-visible surface exposes whether the OS
 * sandbox is on. Verified by measurement — the BotD verdict and the whole coherence vector are
 * unchanged with and without them on a machine where the spawn works either way.
 */
export const linuxSpawnArgs = (): string[] =>
  process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : [];
