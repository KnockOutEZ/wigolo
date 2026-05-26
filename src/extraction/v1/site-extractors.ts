import type { Extractor } from '../../types.js';
import { githubExtractor } from '../site-extractors/github.js';
import { stackoverflowExtractor } from '../site-extractors/stackoverflow.js';
import { mdnExtractor } from '../site-extractors/mdn.js';
import { docsGenericExtractor } from '../site-extractors/docs-generic.js';
import { redditExtractor } from '../site-extractors/reddit.js';
import { youtubeExtractor } from '../site-extractors/youtube.js';

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
  // Re-register slice-added extractors so each test sees the same registry
  // as production. Append-only — see C1/C2/C3 in the gap-closure spec.
  registerSiteExtractor(youtubeExtractor);
}

// Slice C2: YouTube watch pages. Append-only registration so concurrent slices
// (C1 reddit, C3 amazon) don't conflict on the constructor array above.
registerSiteExtractor(youtubeExtractor);
