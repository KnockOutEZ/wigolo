import type { EngineEntry } from './engine-base.js';
import type { Vertical } from './intent-router.js';
import { getGeneralEngines } from './verticals/general.js';
import { getNewsEngines } from './verticals/news.js';
import { getCodeEngines } from './verticals/code.js';
import { getDocsEngines } from './verticals/docs.js';
import { getPapersEngines } from './verticals/papers.js';
import { getImageEngines } from './verticals/images.js';

const ALL_VERTICALS: Vertical[] = ['general', 'news', 'code', 'docs', 'papers', 'images'];

function enginesForVertical(vertical: Vertical): EngineEntry[] {
  switch (vertical) {
    case 'general':
      return getGeneralEngines();
    case 'news':
      return getNewsEngines();
    case 'code':
      return getCodeEngines();
    case 'docs':
      return getDocsEngines();
    case 'papers':
      return getPapersEngines();
    case 'images':
      return getImageEngines();
  }
}

/**
 * Trim, lowercase, drop empties, dedupe. `undefined` when the caller did
 * not actually name any engines (omitted, empty, or whitespace-only).
 */
export function normalizeEngineAllowlist(names?: string[]): string[] | undefined {
  if (!names || names.length === 0) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    if (typeof raw !== 'string') continue;
    const n = raw.trim().toLowerCase();
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out.length > 0 ? out : undefined;
}

function liveCatalog(): Map<string, EngineEntry> {
  const byName = new Map<string, EngineEntry>();
  for (const vertical of ALL_VERTICALS) {
    for (const entry of enginesForVertical(vertical)) {
      const name = entry.engine.name.toLowerCase();
      if (!byName.has(name)) byName.set(name, entry);
    }
  }
  return byName;
}

/**
 * Resolve `search_engines` against the live adapter catalog without
 * dispatching. Used on cache hits so unknown names still become
 * `engine_warnings` when the result payload is served from cache.
 *
 * Matching is live adapters, not the schema catalog: a built-in name that
 * is not in this process (no Brave key, no RSS feeds) is unmatched.
 */
export function inspectSearchEngineAllowlist(names?: string[]): {
  unknownEngines: string[];
  allowlistFallback: boolean;
} {
  const allowlist = normalizeEngineAllowlist(names);
  if (!allowlist) return { unknownEngines: [], allowlistFallback: false };

  const catalog = liveCatalog();
  const unknownEngines = allowlist.filter((name) => !catalog.has(name));
  return {
    unknownEngines,
    allowlistFallback: unknownEngines.length === allowlist.length,
  };
}
