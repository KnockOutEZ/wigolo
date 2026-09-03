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

/**
 * The visits store (SD7 A-18-5). Local-only, agent-partitioned: these reads exist ONLY on this
 * subpath and behind the app, never on an agent-facing tool, provider or index.
 */
export {
  VISIT_RETENTION_DEFAULTS,
  deleteVisits,
  isSiteCaptureEnabled,
  listSiteCapturePrefs,
  listVisits,
  readVisitPage,
  recordVisit,
  searchVisits,
  setSiteCapture,
} from './visit-store.js';
export type {
  DeleteVisitsResult,
  DeleteVisitsScope,
  ListVisitsOptions,
  RecordVisitResult,
  SearchVisitsOptions,
  VisitInput,
  VisitPage,
  VisitRetentionBounds,
  VisitRow,
  VisitSearchRow,
  VisitSkipReason,
  VisitsPage,
} from './visit-store.js';
