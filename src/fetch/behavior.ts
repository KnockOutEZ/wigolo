import type { Page } from 'playwright';
import { createLogger } from '../logger.js';

const log = createLogger('fetch');

export interface Point {
  x: number;
  y: number;
}

export interface HumanizeOptions {
  /** Injectable randomness for deterministic tests. Default Math.random. */
  rng?: () => number;
  /**
   * Hard wall-clock cap for the whole behavioral pass. The layer never spends
   * longer than this, so it can't blow the per-fetch budget. Default ~1200ms.
   */
  maxMs?: number;
  /** Abort signal; when it fires the pass stops between actions. */
  signal?: AbortSignal;
}

const DEFAULT_MAX_MS = 1200;

/** Cubic ease-in-out — realistic acceleration then deceleration of a hand. */
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * Generate a human-like mouse path from `from` to `to`.
 *
 * The path is a cubic Bézier whose two control points are jittered off the
 * straight line (a real hand arcs, it never draws a ruler-straight segment),
 * sampled with a Fitts-law-style step count that scales with distance, and
 * eased so speed ramps up then down. Small per-sample jitter adds micro-tremor.
 * The final point is pinned EXACTLY to `to` so a downstream click lands true.
 *
 * Randomness is injected via `rng` so tests are deterministic.
 */
export function humanMousePath(from: Point, to: Point, rng: () => number = Math.random): Point[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);

  // Step count grows with distance (Fitts-law flavor) but is bounded so a huge
  // move can't produce an unbounded array. Min a few steps even for tiny moves.
  const steps = Math.max(6, Math.min(120, Math.round(distance / 8) + 6));

  // Two control points offset perpendicular to the travel direction, giving the
  // path a natural arc. Offset magnitude scales with distance and rng.
  const perpX = distance === 0 ? 0 : -dy / distance;
  const perpY = distance === 0 ? 0 : dx / distance;
  const arc = Math.min(80, distance * 0.2);
  const off1 = (rng() - 0.5) * 2 * arc;
  const off2 = (rng() - 0.5) * 2 * arc;

  const c1: Point = {
    x: from.x + dx * 0.33 + perpX * off1,
    y: from.y + dy * 0.33 + perpY * off1,
  };
  const c2: Point = {
    x: from.x + dx * 0.66 + perpX * off2,
    y: from.y + dy * 0.66 + perpY * off2,
  };

  const points: Point[] = [];
  const tremor = Math.min(2.5, distance * 0.01);
  for (let i = 0; i <= steps; i++) {
    const tRaw = i / steps;
    const t = easeInOutCubic(tRaw);
    const mt = 1 - t;
    // Cubic Bézier.
    let x =
      mt * mt * mt * from.x + 3 * mt * mt * t * c1.x + 3 * mt * t * t * c2.x + t * t * t * to.x;
    let y =
      mt * mt * mt * from.y + 3 * mt * mt * t * c1.y + 3 * mt * t * t * c2.y + t * t * t * to.y;
    // Micro-tremor on interior points only (never the endpoints).
    if (i !== 0 && i !== steps) {
      x += (rng() - 0.5) * 2 * tremor;
      y += (rng() - 0.5) * 2 * tremor;
    }
    points.push({ x, y });
  }

  // Pin the endpoints exactly.
  points[0] = { x: from.x, y: from.y };
  points[points.length - 1] = { x: to.x, y: to.y };
  return points;
}

/** A browser page that exposes the interaction surface we drive. */
interface InteractablePage {
  mouse?: { move?: (x: number, y: number, opts?: { steps?: number }) => Promise<void> };
  evaluate?: (fn: string | ((...a: never[]) => unknown), ...args: never[]) => Promise<unknown>;
  viewportSize?: () => { width: number; height: number } | null;
}

function isInteractable(page: unknown): page is InteractablePage {
  return (
    typeof page === 'object' &&
    page !== null &&
    typeof (page as InteractablePage).mouse?.move === 'function'
  );
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Apply a bounded, human-like interaction pass to an already-navigated page
 * BEFORE content extraction: a curved mouse traversal plus a small randomized
 * scroll, with randomized inter-action delays. This gives behavioral-scoring
 * anti-bot walls (session mouse movement + scroll + timing) a realistic signal.
 *
 * Safe by construction:
 *  - No-ops cleanly on a page without a real mouse (unit-test mocks, non-
 *    interactive tiers) so callers never need to guard.
 *  - Hard-capped by `maxMs` so it can never blow the per-fetch budget.
 *  - Respects the fetch abort signal between actions.
 *  - Never throws — any page error (detached frame, closed context) is
 *    swallowed and logged at debug; behavioral realism is best-effort.
 */
export async function humanizePage(page: Page, opts: HumanizeOptions = {}): Promise<void> {
  const rng = opts.rng ?? Math.random;
  const maxMs = opts.maxMs ?? DEFAULT_MAX_MS;
  const { signal } = opts;

  if (signal?.aborted) return;
  if (!isInteractable(page)) return;

  const deadline = Date.now() + maxMs;
  const timeLeft = () => deadline - Date.now();

  try {
    const vp = page.viewportSize?.() ?? { width: 1280, height: 800 };
    const width = vp?.width ?? 1280;
    const height = vp?.height ?? 800;

    // A short randomized settle before touching anything (a human doesn't act
    // the instant a page paints).
    if (signal?.aborted || timeLeft() <= 0) return;
    await sleep(80 + Math.floor(rng() * 160), signal);

    // Curved traversal from a plausible entry point to a target inside the
    // upper-content region.
    if (signal?.aborted || timeLeft() <= 0) return;
    const from: Point = {
      x: width * (0.1 + rng() * 0.2),
      y: height * (0.1 + rng() * 0.2),
    };
    const to: Point = {
      x: width * (0.4 + rng() * 0.4),
      y: height * (0.3 + rng() * 0.4),
    };
    const path = humanMousePath(from, to, rng);
    // Spend at most ~55% of the budget on the traversal, leaving room for the
    // scroll + delays. The sub-budget is ENFORCED with its own deadline, not
    // just used to size the per-step delay: on a slow host each `mouse.move`
    // costs real wall-clock (and `sleep(perStep)` rounds up to the platform
    // timer granularity — ~15.6ms on Windows), so a loop bounded only by the
    // GLOBAL deadline eats the whole budget and the scroll never runs. The pass
    // then silently degrades to mouse-only exactly when the machine is busy.
    const moveBudget = Math.max(0, Math.floor(timeLeft() * 0.55));
    const moveDeadline = Date.now() + moveBudget;
    const perStep = path.length > 0 ? Math.min(12, Math.floor(moveBudget / path.length)) : 0;
    for (const p of path) {
      if (signal?.aborted || timeLeft() <= 0 || Date.now() >= moveDeadline) break;
      await page.mouse!.move!(p.x, p.y);
      if (perStep > 0) await sleep(perStep, signal);
    }

    // A small randomized scroll (behavioral scoring weights scroll depth +
    // cadence). Kept modest so it doesn't jump past lazy content.
    if (signal?.aborted || timeLeft() <= 0) return;
    await sleep(60 + Math.floor(rng() * 140), signal);
    if (signal?.aborted || timeLeft() <= 0) return;
    const scrollBy = Math.floor(height * (0.3 + rng() * 0.5));
    if (typeof page.evaluate === 'function') {
      await page.evaluate(
        (y: number) => {
          try {
            window.scrollBy({ top: y, behavior: 'smooth' });
          } catch {
            window.scrollBy(0, y);
          }
        },
        scrollBy as never,
      );
    }
  } catch (err) {
    log.debug('humanize pass encountered a recoverable error (ignored)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
