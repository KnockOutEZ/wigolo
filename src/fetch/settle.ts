// The ONE shared post-goto settle for both browser paths. Single deadline;
// hybrid gate: hydration probe = instant success on recognized content,
// stability poller (content growth stopped) = universal fallback. Never throws
// on timeout — only on abort. Callers capture html/text AFTER this returns.
import { createLogger } from '../logger.js';
import { HYDRATION_PROBE_SOURCE, CONTENT_METRICS_SOURCE } from './hydration-probe.js';
import { abortRejection } from '../util/abort.js';

const log = createLogger('fetch');

export const POST_GOTO_CAP_MS = 6000;
export const NETWORKIDLE_SLICE_MS = 2000;
export const STABILITY_TICK_MS = 400;
export const STABILITY_TICKS_REQUIRED = 2;
export const STABILITY_EPSILON_RATIO = 0.02;
export const STABILITY_EPSILON_CHARS = 40;

export type SettledBy = 'probe' | 'stability' | 'budget';

export interface ContentMetrics {
  textLen: number;
  nodes: number;
}

export interface SettleResult {
  settledBy: SettledBy;
  lastMetrics: ContentMetrics | null;
  stillGrowing: boolean; // true when the budget exit interrupted active growth
}

interface SettlePageHandle {
  waitForLoadState(state: 'networkidle', opts: { timeout: number }): Promise<unknown>;
  waitForFunction(src: string, arg: undefined, opts: { timeout: number }): Promise<unknown>;
  evaluate(src: string): Promise<unknown>;
}

// A tick delta counts as "no growth" only when it is small in BOTH absolute
// chars and relative ratio — either alone is too permissive (a 40-char delta
// on a 200-char page is 20% growth; a 2% delta on a 100k page is 2k chars).
function isStable(prev: ContentMetrics, cur: ContentMetrics): boolean {
  const delta = Math.abs(cur.textLen - prev.textLen);
  const ratio = prev.textLen > 0 ? delta / prev.textLen : 1;
  return delta < STABILITY_EPSILON_CHARS && ratio < STABILITY_EPSILON_RATIO;
}

export async function settlePage(
  page: SettlePageHandle,
  opts: { budgetMs?: number; signal?: AbortSignal; url?: string },
): Promise<SettleResult> {
  const deadline = Date.now() + Math.min(opts.budgetMs ?? POST_GOTO_CAP_MS, POST_GOTO_CAP_MS);
  const remaining = () => Math.max(0, deadline - Date.now());
  const url = opts.url ?? '';

  // Best-effort network settle; bounded slice, never fatal. Abort still wins.
  if (remaining() > 0) {
    await Promise.race([
      page
        .waitForLoadState('networkidle', { timeout: Math.min(remaining(), NETWORKIDLE_SLICE_MS) })
        .catch(() => undefined),
      abortRejection(opts.signal),
    ]);
  }

  let settledBy: SettledBy = 'budget';
  const metricsRef: { last: ContentMetrics | null } = { last: null };
  let stillGrowing = false;

  if (remaining() > 0) {
    let stopStability = false;
    // The in-flight tick timer + its resolver, so teardown can clear the timer
    // AND unblock a poller currently awaiting a tick (leaves no pending timer).
    // Held in a ref object so the closure write is visible to the finally block
    // without TS control-flow narrowing the outer `let` to `never`.
    const tick: { timer: ReturnType<typeof setTimeout> | null; wake: (() => void) | null } = {
      timer: null,
      wake: null,
    };

    // Exit 1: hydration probe (fires instantly on recognized article content).
    // Attach .catch upfront so its post-race rejection never surfaces unhandled.
    const probeWait = page
      .waitForFunction(HYDRATION_PROBE_SOURCE, undefined, { timeout: Math.max(remaining(), 1) })
      .then(() => 'probe' as const)
      .catch(() => null);

    // Exit 2: stability — content stopped growing for N consecutive ticks.
    const stabilityWait = (async (): Promise<'stability' | null> => {
      let stableTicks = 0;
      let prev: ContentMetrics | null = null;
      while (!stopStability && remaining() > 0) {
        const tickMs = Math.min(STABILITY_TICK_MS, remaining());
        await new Promise<void>((r) => {
          tick.wake = r;
          const t = setTimeout(r, tickMs);
          tick.timer = t;
          if (typeof (t as { unref?: () => void }).unref === 'function') (t as { unref: () => void }).unref();
        });
        if (stopStability) return null;
        const cur = (await page.evaluate(CONTENT_METRICS_SOURCE).catch(() => null)) as ContentMetrics | null;
        if (!cur) continue;
        metricsRef.last = cur;
        if (prev && isStable(prev, cur)) {
          stableTicks += 1;
          if (stableTicks >= STABILITY_TICKS_REQUIRED) return 'stability';
        } else {
          stableTicks = 0;
          stillGrowing = prev !== null && cur.textLen > prev.textLen;
        }
        prev = cur;
      }
      return null;
    })();

    // Budget guard: resolves null once the shared deadline is reached.
    let budgetTimer: ReturnType<typeof setTimeout> | null = null;
    const budgetWait = new Promise<null>((r) => {
      budgetTimer = setTimeout(() => r(null), remaining());
      if (typeof (budgetTimer as { unref?: () => void }).unref === 'function') {
        (budgetTimer as { unref: () => void }).unref();
      }
    });

    // finally (not post-await) so an abort rejection still tears down the
    // losing racers — otherwise the stability poller keeps ticking
    // page.evaluate against a page the aborting caller is closing.
    let winner: 'probe' | 'stability' | null;
    try {
      winner = await Promise.race([probeWait, stabilityWait, budgetWait, abortRejection(opts.signal)]);
    } finally {
      stopStability = true;
      if (budgetTimer) clearTimeout(budgetTimer);
      if (tick.timer) clearTimeout(tick.timer);
      // Unblock a poller mid-tick so it re-checks stopStability and exits now,
      // rather than resolving on a stale timer we just cleared.
      if (tick.wake) tick.wake();
    }

    if (winner === 'probe' || winner === 'stability') {
      settledBy = winner;
      stillGrowing = false;
    }
  }

  log.debug('settle complete', { url, settledBy, textLen: metricsRef.last?.textLen ?? -1 });
  return { settledBy, lastMetrics: metricsRef.last, stillGrowing };
}
