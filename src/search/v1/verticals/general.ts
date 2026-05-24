import { BingEngine } from '../../engines/bing.js';
import { DuckDuckGoEngine } from '../../engines/duckduckgo.js';
import { StartpageEngine } from '../../engines/startpage.js';
import { WikipediaEngine } from '../../engines/wikipedia.js';
import { BraveEngine } from '../../engines/brave.js';
import { wrapWithRetryAndBreaker, type EngineEntry } from '../engine-base.js';
import { getConfig } from '../../../config.js';

// Pool diversity matters more than weight precision: every additional
// independent lexical signal dilutes single-engine brand collisions (Bing's
// "next" → next.co.uk) once RRF fuses across the pool. Wikipedia adds a free
// authoritative signal; Brave joins only when an API key is configured so
// users without one see no behavior change.
let cached: EngineEntry[] | null = null;

export function getGeneralEngines(): EngineEntry[] {
  if (cached) return cached;

  const entries: EngineEntry[] = [
    { engine: wrapWithRetryAndBreaker(new BingEngine()), weight: 1, supportsDateFilter: false },
    { engine: wrapWithRetryAndBreaker(new DuckDuckGoEngine()), weight: 1, supportsDateFilter: false },
    { engine: wrapWithRetryAndBreaker(new StartpageEngine()), weight: 1, supportsDateFilter: false },
    { engine: wrapWithRetryAndBreaker(new WikipediaEngine()), weight: 0.6, supportsDateFilter: false },
  ];

  if (getConfig().braveApiKey) {
    entries.push({ engine: wrapWithRetryAndBreaker(new BraveEngine()), weight: 1.1, supportsDateFilter: false });
  }

  cached = entries;
  return cached;
}

export function _resetGeneralEnginesForTest(): void {
  cached = null;
}
