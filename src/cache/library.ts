/** Local-only read surface used by the Studio Library and Personal Wayback. */
export { listLibraryPages } from './store.js';
export type {
  LibraryPageOptions,
  LibraryPageResult,
  LibraryPageRow,
  LibrarySort,
} from './store.js';

export { runHybridSearch } from './hybrid-search.js';
export type {
  HybridSearchInput,
  HybridSearchMethod,
  HybridSearchResult,
} from './hybrid-search.js';

export {
  listVersionMeta,
  listVersionedUrls,
  versionAt,
  versionByHash,
} from './version-read.js';
export type {
  ListVersionedUrlsOptions,
  RetainedVersion,
  VersionedUrlRow,
  VersionedUrlsPage,
} from './version-read.js';

export { computeDiffEnvelope } from './diff-engine.js';
export type { DiffEnvelopeInput } from './diff-engine.js';
