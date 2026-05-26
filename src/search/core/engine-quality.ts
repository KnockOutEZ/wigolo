// Slice S11b: per-engine snippet/source quality registry.
//
// WHY: the audit found that some engines (devdocs, lobsters) produce thin
// snippets ("Title — type", "12 score / 4 comments") while others
// (StackOverflow, Wikipedia, MDN) return rich evidence text. RRF currently
// treats them all uniformly via the static per-engine `weight`. S11c will
// consume the tier here to weight fusion by evidence quality, not just
// engine identity.
//
// THIS SLICE (S11b) only ships the metadata. S11c will:
//   1. Read `qualityRrfMultiplier(tier)` and multiply each engine's RRF
//      contribution by it before fusing.
//   2. Treat `weight` as engine confidence and `quality` as evidence quality;
//      the two are independent and multiply.
//
// We deliberately keep the multiplier inert (returns 1) until S11c flips it
// so tier tagging cannot regress current behavior.
//
// Tier semantics: see EngineQualityTier doc in engine-base.ts.

import type { EngineQualityTier } from './engine-base.js';

/**
 * Static per-engine quality tier. Engine name keys match the `name` field on
 * each SearchEngine implementation. Anything not in this map is treated as
 * `medium` so unknown / plugin engines do not crash the registered-engines
 * test.
 *
 * Notes on individual tiers:
 *  - wikipedia / mdn / stackoverflow: structured JSON APIs with reliable
 *    summary/body fields → high.
 *  - bing / duckduckgo / startpage / bing_news: HTML scrapers, snippets are
 *    usable but vary (sometimes only a date prefix) → medium.
 *  - brave: API JSON with `description`, but the description is often a
 *    one-liner and the source list is narrower → medium.
 *  - hn-algolia: structured JSON but the snippet falls back to
 *    "N points · N comments" when no story text exists → medium.
 *  - lobsters: same fallback pattern as HN and the description is
 *    consistently sparse → low.
 *  - github-code: structured JSON but the snippet is the repository
 *    description or the file path — useful for ranking but rarely
 *    quotable evidence → medium.
 *  - devdocs: static slug lookup, snippet is just "Title — type" → low.
 *  - arxiv / semantic-scholar: structured paper APIs with abstracts when
 *    present, but `abstract` is frequently missing on S2 → medium.
 */
const ENGINE_QUALITY: Record<string, EngineQualityTier> = {
  wikipedia: 'high',
  mdn: 'high',
  stackoverflow: 'high',
  bing: 'medium',
  bing_news: 'medium',
  duckduckgo: 'medium',
  startpage: 'medium',
  brave: 'medium',
  'hn-algolia': 'medium',
  'github-code': 'medium',
  arxiv: 'medium',
  'semantic-scholar': 'medium',
  lobsters: 'low',
  devdocs: 'low',
  // RSS feed engine (news vertical, conditional on config). Curated by the
  // user — treat the per-item content as medium quality by default.
  'rss-feed': 'medium',
  // Slice S11a long-tail web engines: both run independent indexes and are
  // tagged `secondary` in the general vertical so they cannot dominate
  // consensus. Snippets tend to be sparse (Mojeek title+brief; Marginalia
  // small-web descriptions), so `low` matches the S11b convention used for
  // lobsters/devdocs.
  mojeek: 'low',
  marginalia: 'low',
  // Slice S11a image engines: image-search results carry source-page +
  // thumbnail/url + alt text rather than evidence-quality snippets. Tag as
  // `medium` so S11c's RRF tuning treats them like the general medium pool
  // (DDG image is the zero-key floor, Brave image is a key-gated peer).
  'ddg-image': 'medium',
  'brave-image': 'medium',
};

/**
 * Returns the static quality tier for a given engine name. Defaults to
 * 'medium' when the engine is not in the registry — this protects the
 * pipeline from blowing up on plugin engines while still letting S11c
 * apply a sensible weight.
 */
export function engineQualityTier(name: string): EngineQualityTier {
  return ENGINE_QUALITY[name] ?? 'medium';
}

/**
 * RRF weight multiplier for a quality tier. Slice S11b ships this returning
 * 1.0 for every tier so the metadata cannot regress current behavior. S11c
 * will replace the body with real multipliers (e.g. high=1.15, medium=1.0,
 * low=0.85). Keeping the function shape here means S11c is a one-file edit.
 *
 * Documented mapping (S11c WILL implement):
 *   high   → 1.15
 *   medium → 1.00
 *   low    → 0.85
 */
export function qualityRrfMultiplier(_tier: EngineQualityTier): number {
  return 1.0;
}

/**
 * Test-only: snapshot of the full registry for assertions like "every
 * registered engine has a tier". Exported for tests so we do not have to
 * inline the map again.
 */
export function _enginesWithQualityForTest(): ReadonlyArray<[string, EngineQualityTier]> {
  return Object.entries(ENGINE_QUALITY) as Array<[string, EngineQualityTier]>;
}
