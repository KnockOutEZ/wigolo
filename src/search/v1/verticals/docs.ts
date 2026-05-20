import { MdnEngine } from '../../engines/mdn.js';
import { DevDocsEngine } from '../../engines/devdocs.js';
import { wrapWithRetryAndBreaker, type EngineEntry } from '../engine-base.js';

// MDN + devdocs are both first-party docs APIs. We deliberately don't add a
// generic "site:docs.*" engine here — broader docs coverage is handled by the
// orchestrator falling back to the general vertical when needed.
let cached: EngineEntry[] | null = null;

export function getDocsEngines(): EngineEntry[] {
  if (cached) return cached;
  cached = [
    { engine: wrapWithRetryAndBreaker(new MdnEngine()), weight: 1.2, supportsDateFilter: false },
    { engine: wrapWithRetryAndBreaker(new DevDocsEngine()), weight: 0.8, supportsDateFilter: false },
  ];
  return cached;
}

export function _resetDocsEnginesForTest(): void {
  cached = null;
}
