import { abortRejection } from '../util/abort.js';
import { humanMousePath, type Point } from './behavior.js';
import { pollUntilCleared, type ClearanceCookie } from './challenge-completion.js';
import type { SolveMethod } from '../types.js';

/** Structural page token — every browser I/O is injected, so this module never
 *  imports Playwright/CDP. The concrete caller (slice PL) backs the dispatch
 *  callbacks with CDP `Input.dispatchMouseEvent` and passes the live page. */
type PageLike = unknown;

export interface AutoPassOptions {
  /** Opaque page token threaded through the injected readers. */
  page: PageLike;
  /** Viewport coords of the checkbox/widget, or null when there is none to
   *  click (behavioral / none class) — the must-not-fire signal. */
  locateWidget: () => Promise<{ x: number; y: number } | null>;
  /** Trusted CDP mouseMoved dispatch. Called once per Bézier waypoint. */
  dispatchTrustedMove: (x: number, y: number) => Promise<void>;
  /** Trusted CDP mousePressed+mouseReleased dispatch at the widget. */
  dispatchTrustedClick: (x: number, y: number) => Promise<void>;
  readContent: (page: PageLike) => Promise<string>;
  readCookies: (page: PageLike) => Promise<ClearanceCookie[]>;
  /** True while the page still shows a challenge (markers present). */
  isStillChallenge: (html: string) => boolean;
  /** Absolute wall-clock budget for the whole pass (all attempts). */
  deadlineMs: number;
  /** Per-attempt clearance poll budget. Default 1500ms. */
  clearanceBudgetMs?: number;
  /** Delay between clearance polls. Default 150ms. */
  pollIntervalMs?: number;
  /** Delay between move waypoints — human pacing. Default ~8ms. */
  stepDelayMs?: number;
  /** Bounded attempt count. Default 2. */
  maxAttempts?: number;
  /** Injectable randomness for a deterministic path in tests. */
  rng?: () => number;
  /** Abort signal; honored between waypoints and during polls. */
  signal?: AbortSignal;
}

export interface AutoPassResult {
  passed: boolean;
  cookies?: ClearanceCookie[];
  cfClearance?: { value: string; expires: number };
  solveMethod?: SolveMethod;
  /** Populated on a non-pass to explain why (e.g. 'no-widget', 'not-cleared'). */
  reason?: string;
}

const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_CLEARANCE_BUDGET_MS = 1500;
const DEFAULT_POLL_INTERVAL_MS = 150;
const DEFAULT_STEP_DELAY_MS = 8;

/** A plausible cursor entry point offset up-and-left of the widget, so the
 *  Bézier traversal has real distance to arc across rather than starting on top
 *  of the target (a zero-length path is a bot tell). */
function entryPoint(widget: Point, rng: () => number): Point {
  const backX = 60 + rng() * 120;
  const backY = 50 + rng() * 100;
  return { x: Math.max(0, widget.x - backX), y: Math.max(0, widget.y - backY) };
}

/**
 * Automated pass of an INTERACTIVE challenge (Turnstile checkbox / reCAPTCHA
 * "I'm not a robot") with no human and no LLM.
 *
 * The genuinely-better-than-JS-click technique is a TRUSTED mouse gesture:
 * the caller backs `dispatchTrusted*` with CDP `Input.dispatchMouseEvent`
 * (isTrusted-true events a WAF cannot distinguish from a real hand), and this
 * module drives them along a human Bézier path (shared `behavior.ts` helper)
 * with per-waypoint pacing.
 *
 * Mechanism honesty (spec review A2): this does NOT attempt to detach the
 * automation control plane — that is unachievable with a Playwright-owned page.
 * It delivers only the achievable part: trusted dispatch + Bézier pacing.
 *
 * Algorithm: locate widget → null ⇒ must-not-fire `{passed:false,'no-widget'}`
 * → per attempt: move along the Bézier path with trusted dispatches, trusted
 * click on the widget, poll briefly for clearance (cf_clearance cookie OR
 * challenge DOM gone) → cleared ⇒ pass; else retry up to `maxAttempts`.
 * Abort + the overall deadline are honored between waypoints and during polls.
 */
export async function autoPassChallenge(opts: AutoPassOptions): Promise<AutoPassResult> {
  const {
    page,
    locateWidget,
    dispatchTrustedMove,
    dispatchTrustedClick,
    readContent,
    readCookies,
    isStillChallenge,
    deadlineMs,
    signal,
  } = opts;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const clearanceBudgetMs = opts.clearanceBudgetMs ?? DEFAULT_CLEARANCE_BUDGET_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const stepDelayMs = opts.stepDelayMs ?? DEFAULT_STEP_DELAY_MS;
  const rng = opts.rng ?? Math.random;

  const deadline = Date.now() + Math.max(0, deadlineMs);
  // Fail fast on a pre-aborted signal before building the abort rejection, so
  // that rejection is never created unhandled.
  if (signal?.aborted) throw signal.reason;

  // One reusable abort rejection raced against every async step so an abort
  // propagates promptly rather than after the current step resolves.
  const abort = abortRejection(signal);
  // The reused rejection is intentionally left unsettled when no abort fires;
  // swallow its rejection so an abort mid-gesture never surfaces as unhandled
  // (the racing await already propagates the reason to the caller).
  void abort.catch(() => {});

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal?.aborted) throw signal.reason;
    if (Date.now() >= deadline) {
      return { passed: false, reason: 'deadline', solveMethod: 'auto-pass' };
    }

    const widget = await Promise.race([locateWidget(), abort]);
    // Must-not-fire: no checkbox to click (behavioral / none class).
    if (!widget) {
      return { passed: false, reason: 'no-widget', solveMethod: 'auto-pass' };
    }

    // Human motion path from a plausible entry point to the widget, driven via
    // TRUSTED move dispatches with per-waypoint pacing.
    const path = humanMousePath(entryPoint(widget, rng), widget, rng);
    for (const p of path) {
      if (signal?.aborted) throw signal.reason;
      if (Date.now() >= deadline) {
        return { passed: false, reason: 'deadline', solveMethod: 'auto-pass' };
      }
      await Promise.race([dispatchTrustedMove(p.x, p.y), abort]);
      if (stepDelayMs > 0) {
        await Promise.race([
          new Promise<void>((resolve) => setTimeout(resolve, stepDelayMs)),
          abort,
        ]);
      }
    }

    if (signal?.aborted) throw signal.reason;
    await Promise.race([dispatchTrustedClick(widget.x, widget.y), abort]);

    // Brief clearance poll, bounded by both its own budget and the overall
    // deadline. pollUntilCleared honors the same abort signal.
    const remaining = deadline - Date.now();
    const pollBudget = Math.min(clearanceBudgetMs, Math.max(0, remaining));
    const poll = await pollUntilCleared(page, {
      deadlineMs: pollBudget,
      intervalMs: pollIntervalMs,
      isStillChallenge,
      readContent,
      readCookies,
      signal,
    });

    if (poll.cleared) {
      return {
        passed: true,
        cookies: poll.cookies,
        cfClearance: poll.cfClearance,
        solveMethod: 'auto-pass',
      };
    }
  }

  return { passed: false, reason: 'not-cleared', solveMethod: 'auto-pass' };
}
