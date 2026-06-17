// Slice S11a: cold-start engine health summary for doctor + telemetry.
//
// WHY: the spec calls for a "per-engine health-check on cold start" so a
// user running `wigolo doctor` can see at a glance which engines are
// configured, which need an API key, and which are part of the active
// pool. The check is REGISTRY-LEVEL — we do NOT dispatch a live query; we
// inspect the vertical pools + the env-var contract. A live probe would
// (1) slow doctor down by ~14× the engine count, (2) burn rate-budget on
// every doctor invocation, and (3) couple doctor output to flaky third-
// party services. The honest contract is "tell me what would dispatch and
// whether each engine is ready".

import { getConfig } from '../../config.js';
import { getBreakerSnapshot, type BreakerSnapshotState, type EngineEntry } from './engine-base.js';
import { getGeneralEngines } from './verticals/general.js';
import { getNewsEngines } from './verticals/news.js';
import { getCodeEngines } from './verticals/code.js';
import { getDocsEngines } from './verticals/docs.js';
import { getPapersEngines } from './verticals/papers.js';
import { getImageEngines } from './verticals/images.js';
import type { Vertical } from './intent-router.js';

export type EngineHealthStatus = 'ok' | 'needs-key' | 'disabled';

export interface EngineHealthEntry {
  name: string;
  vertical: Vertical;
  status: EngineHealthStatus;
  /** Optional one-line remediation hint when status !== 'ok'. */
  hint?: string;
  /** Informational note about a KNOWN engine limitation that is NOT a
   * misconfiguration — e.g. an engine that intermittently rate-limits/403s by
   * IP reputation rather than anything the user can fix. Surfaced even when
   * status is 'ok' so the doctor output is honest about why an engine may go
   * dark, without implying the user did something wrong. */
  note?: string;
  /** Optional engine weight (for visibility — informational only). */
  weight?: number;
  /** Circuit-breaker state, joined from getBreakerSnapshot(). Omitted for
   * engines that never dispatched in this process (Slice 4). */
  breaker?: BreakerSnapshotState;
  /** Last upstream error the breaker recorded for this engine. */
  lastError?: string;
}

interface KeyRequirement {
  envVar: string;
  /** Whether the engine is registered in the pool when the key is missing.
   * Brave is gated AT pool-construction time — if the key is missing, the
   * engine doesn't even appear in `getGeneralEngines()`. We surface those
   * cases with a `disabled` status to make the absence visible. */
  registeredWithoutKey: boolean;
}

const KEY_REQUIRED: Record<string, KeyRequirement> = {
  brave: { envVar: 'BRAVE_API_KEY', registeredWithoutKey: false },
  'brave-image': { envVar: 'BRAVE_API_KEY', registeredWithoutKey: false },
  'github-code': { envVar: 'WIGOLO_GITHUB_TOKEN', registeredWithoutKey: true },
};

// Wave-2 W3 (honest engine-pool health): known per-engine limitations that
// are NOT misconfigurations and NOT user-fixable. These surface as an
// informational note in doctor even when the engine is otherwise "ok", so a
// user who sees an engine intermittently absent from telemetry understands
// the cause. Mojeek's 403s are IP-reputation / rate-limit driven (see
// src/search/engines/mojeek.ts) — a real fix needs a proxy pool, which is out
// of local scope; the engine already degrades gracefully behind its breaker.
const ENGINE_NOTES: Record<string, string> = {
  mojeek: 'may intermittently 403 (IP reputation / rate-limit, not UA-fixable); degrades gracefully',
};

function noteFor(engineName: string): string | undefined {
  return ENGINE_NOTES[engineName];
}

function isKeyAvailable(engineName: string): boolean {
  const req = KEY_REQUIRED[engineName];
  if (!req) return true;
  // Brave uses BRAVE_API_KEY which the config layer surfaces as braveApiKey.
  if (req.envVar === 'BRAVE_API_KEY') return !!getConfig().braveApiKey;
  // Generic env-var check for everything else.
  return typeof process.env[req.envVar] === 'string' && process.env[req.envVar]!.length > 0;
}

function hintFor(engineName: string): string | undefined {
  const req = KEY_REQUIRED[engineName];
  if (!req) return undefined;
  return `set ${req.envVar} to enable this engine`;
}

function verticalPools(): Array<[Vertical, EngineEntry[]]> {
  return [
    ['general', getGeneralEngines()],
    ['news', getNewsEngines()],
    ['code', getCodeEngines()],
    ['docs', getDocsEngines()],
    ['papers', getPapersEngines()],
    ['images', getImageEngines()],
  ];
}

/**
 * Flattened engine entries across every vertical pool. Used by doctor's
 * `--probe-engines` flag as the live-probe target list (Slice 4). May
 * contain the same engine name more than once when an engine is registered
 * in multiple verticals — callers dedupe by name.
 */
export function getRegisteredEngineEntries(): EngineEntry[] {
  return verticalPools().flatMap(([, entries]) => entries);
}

/**
 * Inspect the configured engine pool across every vertical and return a
 * flat list of (engine, vertical, status) entries. Pure — no network, no
 * side effects. Re-entry-safe and cheap enough to call on every doctor
 * invocation. Used by `doctor` for the engine health summary block.
 */
export function getEngineHealthSummary(): EngineHealthEntry[] {
  const verticals = verticalPools();
  // Slice 4: join live breaker state by engine name so doctor can show
  // which engines are dark right now and why.
  const breakerByEngine = new Map(getBreakerSnapshot().map((s) => [s.engine, s]));

  const out: EngineHealthEntry[] = [];
  // Track which key-required engines we observed in any pool so we can
  // surface a `disabled` entry for engines that were gated out at
  // construction time (Brave in general/code when the key is missing).
  const seen = new Set<string>();

  for (const [vertical, entries] of verticals) {
    for (const entry of entries) {
      const name = entry.engine.name;
      seen.add(name);
      const req = KEY_REQUIRED[name];
      let status: EngineHealthStatus = 'ok';
      let hint: string | undefined;
      if (req && !isKeyAvailable(name)) {
        // Engine present in the pool BUT missing key — Github-code is the
        // canonical case (registered, dispatches, may hit rate-limit 401).
        status = 'needs-key';
        hint = hintFor(name);
      }
      const breaker = breakerByEngine.get(name);
      const note = noteFor(name);
      out.push({
        name,
        vertical,
        status,
        ...(hint ? { hint } : {}),
        ...(note ? { note } : {}),
        ...(entry.weight !== undefined ? { weight: entry.weight } : {}),
        ...(breaker ? { breaker: breaker.state } : {}),
        ...(breaker?.lastError ? { lastError: breaker.lastError } : {}),
      });
    }
  }

  // Surface engines that are gated OUT of every pool because their key is
  // missing. Without this, a user with no BRAVE_API_KEY would never see
  // "brave" in doctor — they'd just see an unexplained absence. We list it
  // with `disabled` so the remediation hint reaches them.
  for (const name of Object.keys(KEY_REQUIRED)) {
    if (seen.has(name)) continue;
    if (!isKeyAvailable(name)) {
      out.push({
        name,
        vertical: name === 'brave-image' ? 'images' : 'general',
        status: 'disabled',
        hint: hintFor(name),
      });
    }
  }

  return out;
}
