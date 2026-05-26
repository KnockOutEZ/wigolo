import type { Extractor } from '../../types.js';
import { githubExtractor } from '../site-extractors/github.js';
import { stackoverflowExtractor } from '../site-extractors/stackoverflow.js';
import { mdnExtractor } from '../site-extractors/mdn.js';
import { docsGenericExtractor } from '../site-extractors/docs-generic.js';
import { redditExtractor } from '../site-extractors/reddit.js';

// Shared registry — used by both the legacy pipeline (`pipeline.ts`) and the v1
// router (`routed.ts`). Plugin site extractors call `registerExtractor` (a
// re-export from pipeline.ts) which mutates this list, so V1 picks them up.

const siteExtractors: Extractor[] = [
  githubExtractor,
  stackoverflowExtractor,
  mdnExtractor,
  docsGenericExtractor,
  redditExtractor,
];

export function registerSiteExtractor(extractor: Extractor): void {
  siteExtractors.push(extractor);
}

export function getSiteExtractors(): readonly Extractor[] {
  return siteExtractors;
}

export function _resetSiteExtractorsForTest(): void {
  siteExtractors.length = 0;
  siteExtractors.push(
    githubExtractor,
    stackoverflowExtractor,
    mdnExtractor,
    docsGenericExtractor,
    redditExtractor,
  );
}
