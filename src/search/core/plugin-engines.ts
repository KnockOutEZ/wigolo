import type { SearchEngine } from '../../types.js';
import { wrapWithRetryAndBreaker, type EngineEntry } from './engine-base.js';

// Search engines loaded from ~/.wigolo/plugins. They join the general web
// dispatch with the same retry + circuit-breaker wrapping as the built-ins.
let entries: EngineEntry[] = [];

export function setPluginSearchEngines(engines: SearchEngine[]): void {
  entries = engines.map((engine) => ({
    engine: wrapWithRetryAndBreaker(engine),
    weight: 1,
    supportsDateFilter: false,
    quality: 'medium',
  }));
}

export function getPluginEngineEntries(): EngineEntry[] {
  return entries;
}
