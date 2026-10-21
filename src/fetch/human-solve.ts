// Human-solve last-resort rung (P7 — demoted, surface-agnostic).
//
// The FINAL fallback of the solve ladder: surface a live challenge to a human,
// wait for them to solve it in a visible browser window, harvest the clearance.
// The automated rungs (reuse / auto-pass / cdp-direct / ai-vision / solver) are
// the product — this rung only fires when nothing automated cleared AND a human
// is actually present to look at a window.
//
// It is USELESS on hosted / VPS / headless (nobody is watching), so it HARD
// NO-OPS unless BOTH (a) explicit consent is given AND (b) a visible surface
// exists. That gate is load-bearing: on those environments we return without
// calling onNeedHuman and without polling, so we never hang a headless fetch
// waiting on a human who will never arrive.
//
// Pure logic + injected deps — mirrors challenge-completion.ts / ai-solve.ts:
// no Playwright import here. The window-raise, the clear-check readers, and the
// challenge markers are all INJECTED. The concrete caller (PL) backs
// onNeedHuman with bring-window-to-front + the stderr prompt, derives consent /
// surface from config, and binds the real page readers. Surface-agnostic so
// Studio adopts this seam un-parked when it lands.

import { createLogger } from '../logger.js';
import { pollUntilCleared, type ClearanceCookie } from './challenge-completion.js';

export type { ClearanceCookie };

const log = createLogger('fetch');

/** Long poll budget for a human-paced solve. */
const DEFAULT_HUMAN_SOLVE_TIMEOUT_MS = 120000;

/** Structural page token — the readers are injected, so this module never
 *  imports Playwright. The concrete caller passes the live browser page. */
type PageLike = unknown;

/** Best-effort context handed to the surface so it can tell the human what to
 *  do. Surface-agnostic: the headed path logs it; Studio later renders it. */
export interface HumanChallengeInfo {
  /** The URL that hit the challenge. */
  url: string;
  /** Coarse challenge class the classifier assigned, when known. */
  challengeClass?: string;
}

export interface HumanSolveOptions {
  /** Opaque live page handle, threaded to the injected readers. */
  page: PageLike;
  /** Context for the human, forwarded verbatim to onNeedHuman. */
  info: HumanChallengeInfo;
  /**
   * True only when a headed / visible browser window exists (PL derives it from
   * config `browserHeadful` / a Studio surface). One half of the hard gate.
   */
  hasVisibleSurface: boolean;
  /** Explicit consent (PL derives it from config `humanSolveConsent`). The
   *  other half of the hard gate. */
  consent: boolean;
  /**
   * Called ONCE when the rung engages — PL backs it with bring-window-to-front
   * plus a clear stderr line ("solve the challenge in the browser window").
   * Never called on the hard no-op path.
   */
  onNeedHuman: (info: HumanChallengeInfo) => Promise<void> | void;
  /** Read the current page HTML (for the clear check). */
  readContent: (page: PageLike) => Promise<string>;
  /** Read the current cookies (for cf_clearance + persistence). */
  readCookies: (page: PageLike) => Promise<ClearanceCookie[]>;
  /** True while the page still shows a challenge — cleared is its negation. */
  isStillChallenge: (html: string) => boolean;
  /** Poll budget (ms). Human-paced, so long: default 120s. */
  humanSolveTimeoutMs?: number;
  /** Delay between clear-polls. */
  intervalMs: number;
  signal?: AbortSignal;
}

export type HumanSolveResult =
  | { solved: true; cookies: ClearanceCookie[]; solveMethod: 'human' }
  | { solved: false; reason: 'no-visible-surface' | 'no-consent' | 'timeout' };

/**
 * Drive a human-solve of a live challenge.
 *
 * HARD NO-OP GATE (load-bearing VPS safety): if consent is missing OR no
 * visible surface exists, return immediately WITHOUT calling onNeedHuman and
 * WITHOUT polling — a headless/hosted fetch must never hang on a human who is
 * not there.
 *
 * Otherwise: engage the surface once (onNeedHuman), then poll until the page
 * clears (cf_clearance appears OR the challenge markers are gone) or the
 * human-paced deadline elapses. An abort propagates promptly with its reason.
 */
export async function humanSolveChallenge(opts: HumanSolveOptions): Promise<HumanSolveResult> {
  const {
    page,
    info,
    hasVisibleSurface,
    consent,
    onNeedHuman,
    readContent,
    readCookies,
    isStillChallenge,
    humanSolveTimeoutMs = DEFAULT_HUMAN_SOLVE_TIMEOUT_MS,
    intervalMs,
    signal,
  } = opts;

  // HARD NO-OP GATE — surface first (a headless run can still have consent, but
  // never a window), then consent.
  if (!hasVisibleSurface) {
    log.debug('human-solve skipped: no visible surface', { url: info.url });
    return { solved: false, reason: 'no-visible-surface' };
  }
  if (!consent) {
    log.debug('human-solve skipped: no consent', { url: info.url });
    return { solved: false, reason: 'no-consent' };
  }

  // Engaged: raise the window / prompt the human exactly once.
  await onNeedHuman(info);

  const res = await pollUntilCleared(page, {
    deadlineMs: humanSolveTimeoutMs,
    intervalMs,
    isStillChallenge,
    readContent,
    readCookies,
    signal,
  });

  if (res.cleared) {
    return { solved: true, cookies: res.cookies, solveMethod: 'human' };
  }
  return { solved: false, reason: 'timeout' };
}
