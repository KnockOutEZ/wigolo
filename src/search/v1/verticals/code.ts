import { GithubCodeEngine } from '../../engines/github-code.js';
import { StackOverflowEngine } from '../../engines/stackoverflow.js';
import { wrapWithRetryAndBreaker, type EngineEntry } from '../engine-base.js';

let cached: EngineEntry[] | null = null;

export function getCodeEngines(): EngineEntry[] {
  if (cached) return cached;
  cached = [
    { engine: wrapWithRetryAndBreaker(new GithubCodeEngine()), weight: 1.2, supportsDateFilter: false },
    { engine: wrapWithRetryAndBreaker(new StackOverflowEngine()), weight: 1.0, supportsDateFilter: true },
  ];
  return cached;
}

export function _resetCodeEnginesForTest(): void {
  cached = null;
}
