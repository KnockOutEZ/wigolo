import { GithubCodeEngine } from '../../engines/github-code.js';
import { StackOverflowEngine } from '../../engines/stackoverflow.js';
import { MdnEngine } from '../../engines/mdn.js';
import { DevDocsEngine } from '../../engines/devdocs.js';
import { wrapWithRetryAndBreaker, type EngineEntry } from '../engine-base.js';

// Code-focused vertical. GitHub-code + StackOverflow handle the bulk of
// developer-intent queries. MDN + DevDocs are admitted at lower weight as
// fallbacks so queries like "pgvector HNSW ef_search tuning" — where the
// GitHub code-search API returns nothing and SO times out — still produce
// usable results instead of an empty list.
let cached: EngineEntry[] | null = null;

export function getCodeEngines(): EngineEntry[] {
  if (cached) return cached;
  cached = [
    { engine: wrapWithRetryAndBreaker(new GithubCodeEngine()), weight: 1.2, supportsDateFilter: false },
    { engine: wrapWithRetryAndBreaker(new StackOverflowEngine()), weight: 1.0, supportsDateFilter: true },
    { engine: wrapWithRetryAndBreaker(new MdnEngine()), weight: 0.5, supportsDateFilter: false },
    { engine: wrapWithRetryAndBreaker(new DevDocsEngine()), weight: 0.4, supportsDateFilter: false },
  ];
  return cached;
}

export function _resetCodeEnginesForTest(): void {
  cached = null;
}
