import { NvdEngine } from '../../engines/nvd.js';
import { OsvEngine } from '../../engines/osv.js';
import { wrapWithRetryAndBreaker, type EngineEntry } from '../engine-base.js';

let cached: EngineEntry[] | null = null;

export function getVulnerabilitiesEngines(): EngineEntry[] {
  if (cached) return cached;
  cached = [
    { engine: wrapWithRetryAndBreaker(new NvdEngine()), weight: 1.2, supportsDateFilter: true, quality: 'high' },
    { engine: wrapWithRetryAndBreaker(new OsvEngine()), weight: 0.9, supportsDateFilter: false, quality: 'medium' },
  ];
  return cached;
}

export function _resetVulnerabilitiesEnginesForTest(): void {
  cached = null;
}
