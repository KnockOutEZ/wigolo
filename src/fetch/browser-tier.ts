import { createLogger } from '../logger.js';
import { installedSubstrateExists } from '../studio/auto-launch.js';

/**
 * D-S10-2 — the ONE function that decides which browser rung this install gets.
 *
 * `warmup`, the router's escalation path, `doctor` and `status` all read this. There is no
 * second display probe and no second "is the substrate here" check, because the repo has
 * already paid for that alternative twice: `hasDisplaySession()` lived in `cdp-direct.ts` with
 * exactly one consumer, and `installedSubstrateExists()` in `auto-launch.ts` with one. A
 * download decision and a routing decision that probe independently can disagree, and the
 * disagreement is silent — which is the failure amended-D1's "two moments" clarification
 * exists to prevent.
 *
 * The resolver returns the REASON alongside the tier. That is not decoration:
 *  - `doctor`/`status` must print why, per D-S10-9;
 *  - a reason derived from the tier would make every "the reason is right" test
 *    self-satisfying, so the reason is produced by the BRANCH and the branches outnumber the
 *    tiers (three tiers, nine reasons).
 *
 * The function is pure apart from one deduplicated `warn` (D-S10-9: no tier decision is
 * silent). Everything it reads is injectable, so the tests drive real branches rather than
 * mutating `process.env` — and so a caller whose environment is not yet available (Electron
 * main before app-ready) can supply one, which is D-S10-2's stated reverses-if.
 */

/** The rung this install resolves to. */
export type BrowserTierId =
  /** Can map a window: the desktop substrate is the rung warmup acquires and the router escalates to. */
  | 'desktop'
  /** The lazy browser-engine rung, with no substrate. Explicitly selected, or degraded to. */
  | 'browser'
  /** No display server: zero substrate bytes, system browser if present, else the lazy rung. */
  | 'no-display';

/**
 * Why a tier was chosen. One value per BRANCH, never derived from the tier — three of these
 * map to `desktop` and three to `browser`, which is what makes assertion 8 falsifiable.
 */
export type BrowserTierReason =
  /** `WIGOLO_BROWSER_TIER` named it outright. */
  | 'explicit_override'
  /** `warmup --browser` selected the lazy rung. */
  | 'flag_override'
  /** Substrate acquisition failed or was skipped; degraded rather than left with no rung. */
  | 'substrate_unavailable'
  /** A substrate is already installed (D13): use it, acquire nothing. */
  | 'installed_substrate_present'
  /** This platform always has a display session; absence of `DISPLAY` means nothing here. */
  | 'platform_display_always'
  /** An X11 display server is present. */
  | 'x11_display'
  /** A Wayland compositor is present. */
  | 'wayland_display'
  /** A virtual display server on a CI runner. Resolves per the display, like any other. */
  | 'virtual_display_ci'
  /** No display server of any kind. */
  | 'no_display_server';

export interface BrowserTierResolution {
  tier: BrowserTierId;
  reason: BrowserTierReason;
  /** One-line human explanation of the branch taken. Never empty. */
  detail: string;
  /** The stated ceiling of this rung. Present only when the rung is weaker than `desktop`. */
  ceiling?: string;
  /** What the operator can do about it. Present whenever the tier is not the plain default. */
  remedy?: string;
  /** D13: a substrate is already installed, so nothing here should download another. */
  deferAcquisition: boolean;
}

export interface BrowserTierInputs {
  /** Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** D13 probe. Defaults to the single seam in `auto-launch.ts`. */
  substrateInstalled?: () => boolean;
  /** A rung selected by a flag (`warmup --browser`). Wins over detection, loses to the env override. */
  requestedTier?: BrowserTierId | null;
  /** Set when a substrate acquisition attempt failed or was skipped, so the rung degrades WITH a reason. */
  substrateUnavailable?: boolean;
}

const TIER_IDS: readonly BrowserTierId[] = ['desktop', 'browser', 'no-display'];

/** `WIGOLO_BROWSER_TIER` — an explicit, two-way override of the detected tier. */
export const BROWSER_TIER_ENV = 'WIGOLO_BROWSER_TIER';

/**
 * The stated ceiling of the no-display rung — D10's v3 clarification (a).
 *
 * All four clauses are load-bearing and each is asserted separately. A ceiling described by
 * ONE example reads narrower than it is, and this one prevents a whole support genre: server
 * and container users expecting desktop pass rates from a rung that structurally cannot reach
 * them. Capability language only — no library or product names.
 */
export const NO_DISPLAY_CEILING =
  'this host cannot map a window, so pages are fetched with a throwaway profile, a fresh fingerprint, ' +
  'an automation-launched browser and a datacenter IP; sites that score those signals will refuse more often here than on a desktop';

/** The lazy-rung ceiling. Weaker than the substrate, but for a different reason than no-display. */
export const LAZY_BROWSER_CEILING =
  'the browser rung runs without a desktop session, so a signed-in page and a human-answerable prompt are both out of reach on this rung';

const REMEDY_NO_DISPLAY =
  'run this on a host with a display session, or attach one, to reach the desktop rung; otherwise no action is needed — the browser rung still fetches';
const REMEDY_SUBSTRATE_UNAVAILABLE =
  're-run `wigolo warmup` to retry the desktop component; the browser rung keeps working in the meantime';
const REMEDY_OVERRIDE = `unset ${BROWSER_TIER_ENV} to return to automatic detection`;
const REMEDY_FLAG = 'omit `--browser` to let the tier be detected';

/**
 * Every user-facing string this module renders, in one place.
 *
 * Assertion 29 greps THIS object for library and product names rather than grepping the file,
 * because the file's comments legitimately discuss the implementation. A capability-language
 * violation in a rendered string is a user-visible defect; the same word in a comment is not.
 */
export const TIER_USER_STRINGS: Record<string, string> = {
  NO_DISPLAY_CEILING,
  LAZY_BROWSER_CEILING,
  REMEDY_NO_DISPLAY,
  REMEDY_SUBSTRATE_UNAVAILABLE,
  REMEDY_OVERRIDE,
  REMEDY_FLAG,
  detail_explicit_override: `the tier was set explicitly by ${BROWSER_TIER_ENV}`,
  detail_flag_override: 'the browser rung was selected explicitly on the command line',
  detail_substrate_unavailable: 'the desktop component is not available on this machine, so the browser rung is used instead',
  detail_installed_substrate_present: 'a desktop component is already installed on this machine and will be used as-is',
  detail_platform_display_always: 'this platform always has a display session, so its absence from the environment is not a signal',
  detail_x11_display: 'a display server is present (DISPLAY is set)',
  detail_wayland_display: 'a display server is present (WAYLAND_DISPLAY is set)',
  detail_virtual_display_ci: 'a virtual display server is present on a CI runner (an Xvfb-style DISPLAY), and it is treated as a display like any other',
  detail_no_display_server: 'no display server was found (neither DISPLAY nor WAYLAND_DISPLAY is set)',
};

const log = createLogger('fetch');

/** Deduplicates the D-S10-9 warn: one per distinct decision per process, not one per fetch. */
const announced = new Set<string>();

/** Test seam — the warn is deduplicated per process, so a suite must be able to clear it. */
export function resetBrowserTierAnnouncements(): void {
  announced.clear();
}

function parseTierEnv(raw: string | undefined): BrowserTierId | null {
  if (!raw) return null;
  const value = raw.trim().toLowerCase();
  return (TIER_IDS as readonly string[]).includes(value) ? (value as BrowserTierId) : null;
}

function detail(reason: BrowserTierReason): string {
  return TIER_USER_STRINGS[`detail_${reason}`];
}

function build(
  tier: BrowserTierId,
  reason: BrowserTierReason,
  extra: { ceiling?: string; remedy?: string; deferAcquisition?: boolean } = {},
): BrowserTierResolution {
  return {
    tier,
    reason,
    detail: detail(reason),
    ...(extra.ceiling ? { ceiling: extra.ceiling } : {}),
    ...(extra.remedy ? { remedy: extra.remedy } : {}),
    deferAcquisition: extra.deferAcquisition ?? false,
  };
}

function ceilingFor(tier: BrowserTierId): string | undefined {
  if (tier === 'no-display') return NO_DISPLAY_CEILING;
  if (tier === 'browser') return LAZY_BROWSER_CEILING;
  return undefined;
}

/**
 * The plain default — a desktop with a display, detected rather than forced. Everything else
 * warns, per D-S10-9.
 */
function isPlainDefault(r: BrowserTierResolution): boolean {
  return (
    r.tier === 'desktop' &&
    (r.reason === 'platform_display_always' ||
      r.reason === 'x11_display' ||
      r.reason === 'wayland_display' ||
      r.reason === 'virtual_display_ci')
  );
}

/**
 * D-S10-9 — a tier decision is never silent.
 *
 * P3a's shipped lesson one layer up: a substrate that fails or is skipped, degrading quietly,
 * is indistinguishable from a broken install. So every non-default decision is emitted once,
 * with the reason and — when there is one — a remedy.
 *
 * The LEVEL is chosen by whether a remedy exists, not by how unusual the branch is. A `warn`
 * whose remedy field is empty is a complaint, and a stream of complaints about a healthy
 * machine is how a genuine warning comes to be filtered out. `installed_substrate_present` is
 * the case that forces the distinction: it is not the plain default, it changes what warmup
 * downloads, and there is nothing whatsoever for the operator to do about it.
 */
function announce(r: BrowserTierResolution): void {
  if (isPlainDefault(r)) return;
  const key = `${r.tier}:${r.reason}`;
  if (announced.has(key)) return;
  announced.add(key);
  const data = {
    tier: r.tier,
    reason: r.reason,
    detail: r.detail,
    ...(r.ceiling ? { ceiling: r.ceiling } : {}),
    ...(r.remedy ? { remedy: r.remedy } : {}),
  };
  if (r.remedy) log.warn('browser tier resolved below the desktop default', data);
  else log.info('browser tier resolved by a non-default branch', data);
}

/**
 * Resolve the browser rung for this install, with the reason it was chosen.
 *
 * Precedence, highest first:
 *  1. `WIGOLO_BROWSER_TIER` — an operator saying what they want, in BOTH directions (it can
 *     force `desktop` on a host detection would call headless, and `no-display` on a desktop).
 *  2. A flag-selected rung (`warmup --browser`).
 *  3. A failed/skipped substrate acquisition — degrade to the browser rung WITH a reason,
 *     never to "no rung and no message".
 *  4. An already-installed substrate (D13): use it, defer acquisition.
 *  5. Display detection.
 */
export function resolveBrowserTier(inputs: BrowserTierInputs = {}): BrowserTierResolution {
  const platform = inputs.platform ?? process.platform;
  const env = inputs.env ?? process.env;
  const probe = inputs.substrateInstalled ?? installedSubstrateExists;

  const override = parseTierEnv(env[BROWSER_TIER_ENV]);
  if (override) {
    const r = build(override, 'explicit_override', {
      ...(ceilingFor(override) ? { ceiling: ceilingFor(override) } : {}),
      remedy: REMEDY_OVERRIDE,
    });
    announce(r);
    return r;
  }

  if (inputs.requestedTier) {
    const r = build(inputs.requestedTier, 'flag_override', {
      ...(ceilingFor(inputs.requestedTier) ? { ceiling: ceilingFor(inputs.requestedTier) } : {}),
      remedy: REMEDY_FLAG,
    });
    announce(r);
    return r;
  }

  if (inputs.substrateUnavailable) {
    const r = build('browser', 'substrate_unavailable', {
      ceiling: LAZY_BROWSER_CEILING,
      remedy: REMEDY_SUBSTRATE_UNAVAILABLE,
    });
    announce(r);
    return r;
  }

  // Display detection. On darwin and win32 a display session is a property of the platform:
  // neither sets DISPLAY, and reading its absence as "no display" would make every Mac a
  // server — so the platform answers first, before either variable is consulted.
  const hasDisplay =
    platform === 'darwin' || platform === 'win32'
      ? true
      : Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);

  if (!hasDisplay) {
    const r = build('no-display', 'no_display_server', {
      ceiling: NO_DISPLAY_CEILING,
      remedy: REMEDY_NO_DISPLAY,
    });
    announce(r);
    return r;
  }

  let reason: BrowserTierReason;
  if (platform === 'darwin' || platform === 'win32') {
    reason = 'platform_display_always';
  } else if (env.DISPLAY) {
    // A CI runner's virtual display is still a display, and it resolves like one. Special-casing
    // CI into no-display would break this repo's own Studio jobs, which run under exactly that.
    reason = env.CI ? 'virtual_display_ci' : 'x11_display';
  } else {
    reason = 'wayland_display';
  }

  if (probe()) {
    const r = build('desktop', 'installed_substrate_present', { deferAcquisition: true });
    announce(r);
    return r;
  }

  const r = build('desktop', reason);
  announce(r);
  return r;
}
