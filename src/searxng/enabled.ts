import { getBootstrapState } from './bootstrap.js';

/**
 * The narrow config shape these predicates read. Accepting a structural type
 * (rather than the full `Config`) keeps them cheap to unit-test and callable
 * from anywhere that already holds these three fields.
 */
export interface SearxngConfigView {
  searchBackend: string | null;
  searxngUrl: string | null;
  dataDir: string;
}

/**
 * Whether the multi-engine search backend (the search-engine sidecar) is
 * OPTED INTO. True when the selected backend is `searxng` or `hybrid` (whose
 * fallback tier is the sidecar), OR when an external sidecar URL is configured.
 *
 * The default `core` backend with no URL returns false — the zero-config path
 * that must perform no sidecar activity (no resolve, no state writes, no port
 * probes, no process construction).
 */
export function searxngConfigured(cfg: SearxngConfigView): boolean {
  if (cfg.searxngUrl) return true;
  const backend = cfg.searchBackend ?? 'core';
  return backend === 'searxng' || backend === 'hybrid';
}

/**
 * Whether an actually-usable sidecar endpoint exists RIGHT NOW — either an
 * external URL, or a previously-installed native process whose on-disk state is
 * `ready`. Distinct from {@link searxngConfigured}: a user can opt into the
 * `hybrid`/`searxng` backend (configured) without ever having installed the
 * sidecar (not available). In that gap the caller must emit an actionable
 * message rather than install implicitly.
 */
export function searxngBackendAvailable(cfg: SearxngConfigView): boolean {
  if (cfg.searxngUrl) return true;
  const state = getBootstrapState(cfg.dataDir);
  return state?.status === 'ready';
}
