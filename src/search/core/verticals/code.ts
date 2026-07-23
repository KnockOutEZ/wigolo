import { GithubCodeEngine } from '../../engines/github-code.js';
import { StackOverflowEngine } from '../../engines/stackoverflow.js';
import { MdnEngine } from '../../engines/mdn.js';
import { DevDocsEngine } from '../../engines/devdocs.js';
import { DuckDuckGoEngine } from '../../engines/duckduckgo.js';
import { BraveEngine } from '../../engines/brave.js';
import { CratesIoEngine } from '../../engines/crates-io.js';
import { wrapWithRetryAndBreaker, type EngineEntry } from '../engine-base.js';
import { getConfig } from '../../../config.js';

// Code-focused vertical. GitHub-code + StackOverflow are the canonical
// code-intent engines; DuckDuckGo + DevDocs + Brave (when configured) add
// general developer-search breadth so database/library queries like
// "pgvector HNSW ef_search tuning" reach blog posts and vendor docs.
//
// MDN and crates.io are admitted as SECONDARY engines — they still run, but
// the orchestrator demotes results contributed only by secondary engines when
// their lexical alignment with the query is low. This keeps MDN available for
// genuine JS/HTML/CSS queries (and crates.io for genuine Rust-crate queries)
// while preventing narrow-topic pages from hijacking results for unrelated
// queries like "pgvector HNSW".
let cached: EngineEntry[] | null = null;

export function getCodeEngines(): EngineEntry[] {
  if (cached) return cached;

  const entries: EngineEntry[] = [
    {
      engine: wrapWithRetryAndBreaker(new GithubCodeEngine()),
      weight: 1.2,
      supportsDateFilter: false,
      quality: 'medium',
    },
    {
      engine: wrapWithRetryAndBreaker(new StackOverflowEngine()),
      weight: 1.0,
      supportsDateFilter: true,
      quality: 'high',
    },
    {
      engine: wrapWithRetryAndBreaker(new DevDocsEngine()),
      weight: 0.6,
      supportsDateFilter: false,
      quality: 'low',
    },
    {
      engine: wrapWithRetryAndBreaker(new DuckDuckGoEngine()),
      weight: 0.8,
      supportsDateFilter: false,
      quality: 'medium',
    },
  ];

  if (getConfig().braveApiKey) {
    entries.push({
      engine: wrapWithRetryAndBreaker(new BraveEngine()),
      weight: 1.0,
      supportsDateFilter: false,
      quality: 'medium',
    });
  }

  entries.push({
    engine: wrapWithRetryAndBreaker(new MdnEngine()),
    weight: 0.3,
    supportsDateFilter: false,
    secondary: true,
    quality: 'high',
  });

  entries.push({
    engine: wrapWithRetryAndBreaker(new CratesIoEngine()),
    weight: 0.3,
    supportsDateFilter: false,
    secondary: true,
    quality: 'high',
  });

  cached = entries;
  return cached;
}

export function _resetCodeEnginesForTest(): void {
  cached = null;
}
