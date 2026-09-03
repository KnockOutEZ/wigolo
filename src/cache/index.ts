/**
 * Public surface of `src/cache/` for the companion split (`wigolo/cache`).
 *
 * The database handle keeps its own long-standing `wigolo/cache/db` subpath; this adds
 * the store helpers and the artifact-provider contract the extracted layer registers against.
 */
export {
  getAuthenticatedCorpusStats,
  normalizeUrl,
  purgeAuthenticatedCorpus,
  sanitizeFtsQuery,
} from './store.js';
export type {
  AuthenticatedCorpusPurgeOptions,
  AuthenticatedCorpusPurgeResult,
  AuthenticatedCorpusStats,
} from './store.js';
export type { ArtifactProvider, ArtifactRecord } from './artifact-registry.js';
