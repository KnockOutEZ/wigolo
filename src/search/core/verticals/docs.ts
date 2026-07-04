import { MdnEngine } from '../../engines/mdn.js';
import { DevDocsEngine } from '../../engines/devdocs.js';
import { BingEngine } from '../../engines/bing.js';
import { DuckDuckGoEngine } from '../../engines/duckduckgo.js';
import { wrapWithRetryAndBreaker, type EngineEntry } from '../engine-base.js';

// MDN + DevDocs are the first-party docs APIs and stay the primary signal. On
// their own the pool is only two engines — any docs subject they don't index
// (server configs, framework guides, vendor docs) starves to zero. General-web
// engines are added as SECONDARY entries so every docs query has web recall,
// while the orchestrator's secondary-only demotion keeps them from outranking a
// real MDN/DevDocs hit whose lexical alignment is high.
let cached: EngineEntry[] | null = null;

export function getDocsEngines(): EngineEntry[] {
  if (cached) return cached;
  cached = [
    { engine: wrapWithRetryAndBreaker(new MdnEngine()), weight: 1.2, supportsDateFilter: false, quality: 'high' },
    { engine: wrapWithRetryAndBreaker(new DevDocsEngine()), weight: 0.8, supportsDateFilter: false, quality: 'low' },
    { engine: wrapWithRetryAndBreaker(new BingEngine()), weight: 0.7, supportsDateFilter: false, secondary: true, quality: 'medium' },
    { engine: wrapWithRetryAndBreaker(new DuckDuckGoEngine()), weight: 0.7, supportsDateFilter: false, secondary: true, quality: 'medium' },
  ];
  return cached;
}

export function _resetDocsEnginesForTest(): void {
  cached = null;
}
