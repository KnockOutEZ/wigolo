import { BingEngine } from '../../engines/bing.js';
import { DuckDuckGoEngine } from '../../engines/duckduckgo.js';
import { StartpageEngine } from '../../engines/startpage.js';
import { wrapWithRetryAndBreaker, type EngineEntry } from '../engine-base.js';

let cached: EngineEntry[] | null = null;

export function getGeneralEngines(): EngineEntry[] {
  if (cached) return cached;
  cached = [
    { engine: wrapWithRetryAndBreaker(new BingEngine()), weight: 1, supportsDateFilter: false },
    { engine: wrapWithRetryAndBreaker(new DuckDuckGoEngine()), weight: 1, supportsDateFilter: false },
    { engine: wrapWithRetryAndBreaker(new StartpageEngine()), weight: 1, supportsDateFilter: false },
  ];
  return cached;
}

export function _resetGeneralEnginesForTest(): void {
  cached = null;
}
