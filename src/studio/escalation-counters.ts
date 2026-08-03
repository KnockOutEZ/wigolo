import { mkdirSync, writeFileSync, readFileSync, renameSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { getConfig } from '../config.js';

/**
 * S9 / D10(a) — LOCAL escalation-rate counters.
 *
 * D9's budget default was shipped as an admitted placeholder, because nobody yet knows what a real task
 * spends on one origin. These counters are how that gets answered with numbers instead of another argument.
 *
 * LOCAL ONLY. There is NO phone-home, no telemetry hook, and no network code in this module. The counters
 * live in the user's own data dir and are surfaced by `doctor`. They are aggregate integers with no origin,
 * URL, or timestamp attached — a per-origin history would be browsing history, which is exactly what the
 * F5 reporting rule refuses to disclose.
 *
 * Every write is best-effort: an instrumentation failure must never affect a fetch.
 */

export interface EscalationCounters {
  /** Times the challenge ladder terminally failed and the Studio bridge was consulted. */
  bridgeAttempted: number;
  /** Times the bridge returned a page. */
  bridgeServed: number;
  /** Times the bridge declined (no session, human holding, login page, dead host). */
  bridgeDeclined: number;
  /** Times a per-origin budget refused a navigation. This is the number that prices the default. */
  budgetRefused: number;
  /** Times the authenticated-use grant card was shown to a human. */
  cardShown: number;
  cardApproved: number;
  cardRefused: number;
  /** Times the card could not be shown because no approval surface was attached (background runs). */
  cardUnattended: number;
}

export type EscalationCounterKey = keyof EscalationCounters;

const ZERO: EscalationCounters = {
  bridgeAttempted: 0,
  bridgeServed: 0,
  bridgeDeclined: 0,
  budgetRefused: 0,
  cardShown: 0,
  cardApproved: 0,
  cardRefused: 0,
  cardUnattended: 0,
};

interface CounterFile extends EscalationCounters {
  v: 1;
}

function counterPath(dataDir?: string): string {
  return join(dataDir ?? getConfig().dataDir, 'studio', 'escalation-counters.json');
}

export function readEscalationCounters(dataDir?: string): EscalationCounters {
  try {
    const parsed = JSON.parse(readFileSync(counterPath(dataDir), 'utf-8')) as CounterFile;
    if (!parsed || parsed.v !== 1) return { ...ZERO };
    const out = { ...ZERO };
    for (const k of Object.keys(ZERO) as EscalationCounterKey[]) {
      const v = parsed[k];
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[k] = Math.floor(v);
    }
    return out;
  } catch {
    return { ...ZERO };
  }
}

/** Increment one counter. Best-effort: swallows every error — instrumentation never fails a fetch. */
export function bumpEscalationCounter(key: EscalationCounterKey, dataDir?: string): void {
  try {
    const current = readEscalationCounters(dataDir);
    current[key] += 1;
    const finalPath = counterPath(dataDir);
    mkdirSync(join(finalPath, '..'), { recursive: true, mode: 0o700 });
    const tmpPath = `${finalPath}.${process.pid}.tmp`;
    const body: CounterFile = { v: 1, ...current };
    writeFileSync(tmpPath, JSON.stringify(body), { mode: 0o600 });
    chmodSync(tmpPath, 0o600);
    renameSync(tmpPath, finalPath);
  } catch {
    /* instrumentation is never load-bearing */
  }
}

/**
 * Human-readable lines for `doctor`. Aggregate integers only — no origins, so nothing here is a
 * browsing-history disclosure, and nothing leaves the machine.
 */
export function formatEscalationCounterLines(c: EscalationCounters): string[] {
  const bridgeRate = c.bridgeAttempted === 0 ? 'n/a' : `${Math.round((c.bridgeServed / c.bridgeAttempted) * 100)}%`;
  return [
    `  Bridge: ${c.bridgeAttempted} attempted, ${c.bridgeServed} served, ${c.bridgeDeclined} declined (served ${bridgeRate})`,
    `  Pacing: ${c.budgetRefused} request(s) held back by a per-origin budget`,
    `  Sign-in prompts: ${c.cardShown} shown (${c.cardApproved} allowed, ${c.cardRefused} declined), ${c.cardUnattended} skipped with nobody attached`,
    '  These counters are local only — they are never sent anywhere.',
  ];
}
