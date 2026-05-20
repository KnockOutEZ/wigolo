import { HnAlgoliaEngine } from '../../engines/hn-algolia.js';
import { LobstersEngine } from '../../engines/lobsters.js';
import { wrapWithRetryAndBreaker, type EngineEntry } from '../engine-base.js';

let cached: EngineEntry[] | null = null;

export function getNewsEngines(): EngineEntry[] {
  if (cached) return cached;
  cached = [
    { engine: wrapWithRetryAndBreaker(new HnAlgoliaEngine()), weight: 1.2, supportsDateFilter: true },
    // Lobsters /search.json has no native date filter; engine applies client-side
    // filtering. Mark false so the orchestrator treats it as date-naive.
    { engine: wrapWithRetryAndBreaker(new LobstersEngine()), weight: 1.0, supportsDateFilter: false },
  ];
  return cached;
}

export function _resetNewsEnginesForTest(): void {
  cached = null;
}
