// Built-in search-engine names, grouped by the vertical that registers them.
//
// WHY: `search_engines` is an allowlist of adapter `name` strings. The MCP
// arg description cannot list every name (80-token budget), so doctor and
// `engine_warnings` hints carry the listing. Adding an engine in a vertical
// without updating this file fails the drift test.

import type { Vertical } from './intent-router.js';

/**
 * Canonical built-in adapter names per vertical. Includes key-gated engines
 * (`brave`, `brave-image`) and the opt-in news `rss-feed` so the warning
 * hint lists every name a caller can pass, not only the ones live here.
 * An engine registered in multiple verticals appears in each.
 */
export const BUILTIN_ENGINES_BY_VERTICAL: Record<Vertical, readonly string[]> = {
  general: ['bing', 'duckduckgo', 'wikipedia', 'mojeek', 'marginalia', 'brave'],
  news: ['hn-algolia', 'lobsters', 'bing_news', 'duckduckgo', 'mojeek', 'rss-feed'],
  code: [
    'github-code',
    'stackoverflow',
    'devdocs',
    'duckduckgo',
    'mdn',
    'crates-io',
    'npm-registry',
    'pypi',
    'brave',
  ],
  docs: ['mdn', 'devdocs', 'bing', 'duckduckgo'],
  papers: ['arxiv', 'semantic-scholar'],
  images: ['ddg-image', 'brave-image'],
};

const VERTICAL_ORDER: readonly Vertical[] = [
  'general',
  'news',
  'code',
  'docs',
  'papers',
  'images',
];

/** Compact `vertical: name, name; ...` listing used in `engine_warnings` hints. */
export function formatEngineCatalogListing(): string {
  return VERTICAL_ORDER.map(
    (vertical) => `${vertical}: ${BUILTIN_ENGINES_BY_VERTICAL[vertical].join(', ')}`,
  ).join('; ');
}

/**
 * MCP / CLI / OpenAPI description for `search_engines`. Kept short for the
 * 80-token arg-description budget; names live in doctor + warning hints.
 */
export function searchEnginesSchemaDescription(): string {
  return (
    'Override engine selection (case-insensitive). Unknown names appear in ' +
    'engine_warnings; if none match, the default pool is used. ' +
    '`wigolo doctor` prints the live names.'
  );
}

/**
 * Actionable hint attached to `unknown_engine` warnings so a mistyped
 * allowlist tells the caller which strings would have matched.
 */
export function formatEngineCatalogHint(): string {
  return (
    `available: ${formatEngineCatalogListing()}. ` +
    'Names are case-insensitive. Run `wigolo doctor` for live status.'
  );
}
