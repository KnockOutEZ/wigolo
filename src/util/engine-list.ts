/** Normalise a caller-supplied engine list: trim, lowercase, dedupe, sort.
 * Mirrors the orchestrator's case-insensitive engine matching, so
 * `['DuckDuckGo']`, `['duckduckgo']`, whitespace-padded, reordered, or
 * duplicate-name lists — all of which dispatch the same engine set — hit
 * the same allowlist gates AND produce identical cache keys. Shared by the
 * cache-key fingerprint (cache/store.ts) and every engineFilter gate in the
 * orchestrator so the two can never drift apart (a padded value that misses
 * the dispatch allowlist but trims into the cache key would file a
 * full-roster response under a single-engine key). An all-blank list
 * normalises to null, i.e. "no filter". */
export function normaliseEngineList(list?: string[] | null): string[] | null {
  if (!list || list.length === 0) return null;
  const lower = list.map((e) => e.toLowerCase().trim()).filter((e) => e.length > 0);
  if (lower.length === 0) return null;
  return [...new Set(lower)].sort();
}
