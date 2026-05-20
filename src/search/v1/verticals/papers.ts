import { ArxivEngine } from '../../engines/arxiv.js';
import { SemanticScholarEngine } from '../../engines/semantic-scholar.js';
import { wrapWithRetryAndBreaker, type EngineEntry } from '../engine-base.js';

let cached: EngineEntry[] | null = null;

export function getPapersEngines(): EngineEntry[] {
  if (cached) return cached;
  cached = [
    // arXiv's API doesn't accept a date range natively; the engine filters
    // client-side. We still flag supportsDateFilter: true so the orchestrator
    // can treat date-aware queries uniformly.
    { engine: wrapWithRetryAndBreaker(new ArxivEngine()), weight: 1.1, supportsDateFilter: true },
    { engine: wrapWithRetryAndBreaker(new SemanticScholarEngine()), weight: 1.0, supportsDateFilter: true },
  ];
  return cached;
}

export function _resetPapersEnginesForTest(): void {
  cached = null;
}
