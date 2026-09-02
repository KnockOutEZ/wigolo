import { mkdirSync, writeFileSync, readFileSync, renameSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { getConfig } from '../config.js';
import { resolveBrowserTier, type BrowserTierId } from './browser-tier.js';
import type { RawFetchResult, StageError } from '../types.js';
import { isStageError } from './error-describe.js';

/**
 * D-S10-4 — LOCAL tier-occupancy counters: which rung of the fetch ladder each request
 * actually terminated at, keyed by the browser tier this host resolved to.
 *
 * WHY A SECOND SET OF COUNTERS EXISTS. D10(b) asks whether a companion path is worth building
 * for hosts that cannot reach the desktop rung. The shipped D10(a) instrument
 * (`companion/escalation-counters.ts`) cannot answer that: every one of its increments lives in
 * `companion-bridge.ts` or the companion host, and on a server, CI runner or devcontainer the bridge
 * is exactly what is absent. Those counters read zero forever there, and zero is
 * indistinguishable from "no demand". The population the decision is about is the one the
 * shipped instrument cannot see, so choosing the companion shape on its data would be choosing
 * it on an artifact of where the counters were placed.
 *
 * These increment on the ROUTER path instead — one seam at `SmartRouter.fetch`'s exit, which
 * every fetch passes through whether or not a substrate exists anywhere on the machine.
 *
 * WHY KEYED BY TIER rather than flat. The question is not "how busy is the browser rung", it is
 * "how busy is the browser rung ON A HOST THAT CANNOT MAP A WINDOW". A flat total answers the
 * first and cannot answer the second, and it would also conflate the before and after of S10-d's
 * desktop flip on any machine whose tier changes underneath it.
 *
 * Same discipline as D10(a), for the same reason: aggregate integers, no origins, no URLs, no
 * timestamps. LOCAL ONLY — there is no phone-home and no network code in this module. A
 * per-origin breakdown would be browsing history, which is what the F5 reporting rule refuses to
 * disclose, and knowing WHICH sites drove the browser rung is not needed to size the rung.
 *
 * Every write is best-effort: an instrumentation failure must never affect a fetch.
 *
 * ⚠ THE DENOMINATOR IS PAGES, NOT TASKS, and whoever reads this data for D10(b) needs to know
 * it. `crawl` fans out through `handleFetch` into this same seam, so one crawl of 200 pages
 * contributes 200. That is the right denominator for sizing a rung's LOAD and the wrong one for
 * "how many pieces of work needed the browser" — a single crawl of a static docs site can bury
 * a genuine browser-rung signal under HTTP counts, and reading the ratio as demand would then
 * conclude "no demand" from what is really one busy crawler.
 *
 * ⚠ KNOWN LIMIT, stated rather than smoothed over: the write is read-modify-write, so two
 * wigolo processes fetching concurrently can lose an update. These are occupancy PROPORTIONS
 * read off one machine's `doctor`, not an audit log, and the loss is not biased toward any one
 * rung. If a future consumer needs exact totals, that consumer needs a different instrument, not
 * a lock on this one.
 */

/** The rungs of the fetch ladder, plus the two failure outcomes D10(b) turns on. */
export interface TierOccupancyCounts {
  /** Terminated at the plain HTTP rung — content returned, whatever its status code. */
  http: number;
  /** Terminated at the TLS-impersonation rung with content. */
  tls: number;
  /** Terminated at the browser rung with content. THE number D10(b) is about. */
  browser: number;
  /** Terminated at the substrate/bridge rung — the human's own attended session served it. */
  substrate: number;
  /** The browser rung was needed and could not be supplied within budget. Unmet demand. */
  browserUnavailable: number;
  /** The whole ladder terminated on a bot-protection challenge. Demand nothing met. */
  blocked: number;
}

export type TierOccupancyKey = keyof TierOccupancyCounts;

/** Occupancy per resolved browser tier. A host normally only ever populates one of these. */
export type TierOccupancy = Record<BrowserTierId, TierOccupancyCounts>;

const TIERS: readonly BrowserTierId[] = ['desktop', 'browser', 'no-display'];

const ZERO_COUNTS: TierOccupancyCounts = {
  http: 0,
  tls: 0,
  browser: 0,
  substrate: 0,
  browserUnavailable: 0,
  blocked: 0,
};

const COUNT_KEYS = Object.keys(ZERO_COUNTS) as TierOccupancyKey[];

function zero(): TierOccupancy {
  return {
    desktop: { ...ZERO_COUNTS },
    browser: { ...ZERO_COUNTS },
    'no-display': { ...ZERO_COUNTS },
  };
}

interface OccupancyFile {
  v: 1;
  tiers: Partial<Record<BrowserTierId, Partial<TierOccupancyCounts>>>;
}

/**
 * The counters live at the SHARED data-dir root, not under the Studio state dir.
 *
 * The whole point of the instrument is that it works on a host with no substrate at all, and
 * filing its output under the substrate's directory would say the opposite.
 */
function counterPath(dataDir?: string): string {
  return join(dataDir ?? getConfig().dataDir, 'tier-occupancy.json');
}

export function readTierOccupancy(dataDir?: string): TierOccupancy {
  try {
    const parsed = JSON.parse(readFileSync(counterPath(dataDir), 'utf-8')) as OccupancyFile;
    if (!parsed || parsed.v !== 1 || typeof parsed.tiers !== 'object' || parsed.tiers === null) return zero();
    const out = zero();
    for (const tier of TIERS) {
      const stored = parsed.tiers[tier];
      if (!stored || typeof stored !== 'object') continue;
      for (const key of COUNT_KEYS) {
        const v = stored[key];
        if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[tier][key] = Math.floor(v);
      }
    }
    return out;
  } catch {
    return zero();
  }
}

/** Increment one counter under one tier. Best-effort: swallows every error. */
export function bumpTierOccupancy(tier: BrowserTierId, key: TierOccupancyKey, dataDir?: string): void {
  try {
    const current = readTierOccupancy(dataDir);
    current[tier][key] += 1;
    const finalPath = counterPath(dataDir);
    mkdirSync(dirname(finalPath), { recursive: true, mode: 0o700 });
    const tmpPath = `${finalPath}.${process.pid}.tmp`;
    const body: OccupancyFile = { v: 1, tiers: current };
    writeFileSync(tmpPath, JSON.stringify(body), { mode: 0o600 });
    chmodSync(tmpPath, 0o600);
    renameSync(tmpPath, finalPath);
  } catch {
    /* instrumentation is never load-bearing */
  }
}

/**
 * Results served by the substrate/bridge rung, by object identity.
 *
 * `companion-bridge.ts` deliberately reports `method: 'browser'`, and its comment says why: for
 * every downstream consumer (cache staleness, research source filtering, completeness) a page
 * off a real browser IS a browser page. For OCCUPANCY they are different rungs — that is the
 * whole distinction D10(b) turns on — so the router marks the bridge's result as it passes and
 * the recorder reads the mark.
 *
 * Identity rather than a flag on the router: two concurrent fetches would race a flag, and a
 * substrate serve attributed to the wrong concurrent request is exactly the kind of quiet skew
 * that makes a measurement uninterpretable later. A WeakSet holds nothing alive.
 */
const substrateServed = new WeakSet<object>();

/** Mark a result as having come off the substrate/bridge rung. Returns it unchanged. */
export function markSubstrateServed<T extends object>(result: T): T {
  substrateServed.add(result);
  return result;
}

function wasSubstrateServed(result: unknown): boolean {
  return typeof result === 'object' && result !== null && substrateServed.has(result);
}

/**
 * Which counter a terminal fetch result belongs to, or `null` when it belongs to none.
 *
 * Pure, so the mapping is asserted without a filesystem.
 *
 * The `null` cases are deliberate, and each is asserted:
 *  - `navigation_blocked` is the exfil guard refusing before ANY fetcher runs. No rung was
 *    occupied, so counting it would inflate a denominator with requests that never left.
 *  - `reddit-api` is an origin-specific credentialed escape hatch, not a rung on the ladder.
 *    Counting it as HTTP would credit the HTTP rung with pages it cannot fetch.
 *  - a transport failure (`playwright_fetch_failed`) is a fault, not an occupancy fact, and
 *    D10(b) is being sized on demand rather than on flakiness.
 */
export function classifyFetchOutcome(result: RawFetchResult | StageError): TierOccupancyKey | null {
  if (isStageError(result)) {
    switch (result.error) {
      case 'blocked_by_challenge':
        return 'blocked';
      // Both mean the same thing for sizing: the ladder wanted the browser rung and this host
      // could not supply it. They differ only in whether an install was attempted.
      case 'browser_engine_unavailable':
      case 'playwright_not_installed':
        return 'browserUnavailable';
      default:
        return null;
    }
  }
  if (wasSubstrateServed(result)) return 'substrate';
  switch (result.method) {
    case 'http':
      return 'http';
    case 'tls-impersonation':
      return 'tls';
    case 'browser':
      return 'browser';
    default:
      return null;
  }
}

/**
 * Record one terminal fetch outcome against the tier this host resolved to.
 *
 * Called from the single exit of `SmartRouter.fetch`. `tier` is injectable so the unit tests
 * drive a no-display host without an environment; production reads the one resolver.
 */
export function recordFetchOutcome(
  result: RawFetchResult | StageError,
  opts: { tier?: BrowserTierId; dataDir?: string } = {},
): void {
  const key = classifyFetchOutcome(result);
  if (!key) return;
  const tier = opts.tier ?? resolveBrowserTier().tier;
  bumpTierOccupancy(tier, key, opts.dataDir);
}

/** True when this host has recorded any outcome at all — the gate for rendering the section. */
export function tierOccupancyUsed(occupancy: TierOccupancy): boolean {
  return TIERS.some((t) => COUNT_KEYS.some((k) => occupancy[t][k] > 0));
}

/**
 * Human-readable lines for `doctor`. Aggregate integers only — no origins, so nothing here is a
 * browsing-history disclosure, and nothing leaves the machine.
 *
 * Only tiers this host has actually recorded under are printed: a machine that has always been
 * a desktop should not be shown two empty rows inviting it to wonder what it did wrong.
 */
export function formatTierOccupancyLines(occupancy: TierOccupancy): string[] {
  if (!tierOccupancyUsed(occupancy)) {
    return ['  No fetches recorded yet on this machine.'];
  }
  const lines: string[] = [];
  for (const tier of TIERS) {
    const c = occupancy[tier];
    if (!COUNT_KEYS.some((k) => c[k] > 0)) continue;
    lines.push(
      `  On the ${tier} tier: ${c.http} served by a direct request, ${c.tls} by a hardened request, ` +
        `${c.browser} by a browser engine, ${c.substrate} by an attended browser session`,
    );
    if (c.browserUnavailable > 0 || c.blocked > 0) {
      lines.push(
        `    Unmet: ${c.browserUnavailable} needed a browser engine this machine could not start, ` +
          `${c.blocked} ended at a bot-protection challenge`,
      );
    }
  }
  lines.push('  These counters are local only — they are never sent anywhere.');
  return lines;
}
