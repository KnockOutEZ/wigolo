// Per-engine snippet/source quality registry.
// Tier-to-weight mapping consumed by RRF fusion.
//
// WHY: some engines (devdocs, lobsters) produce thin
// snippets ("Title — type", "12 score / 4 comments") while others
// (StackOverflow, Wikipedia, MDN) return rich evidence text. A uniform
// static per-engine `weight` treats them all the same.
// `qualityRrfMultiplier` uses the tier weights below so fusion is keyed
// by evidence quality, not just engine identity.
//
// Tier semantics: see EngineQualityTier doc in engine-base.ts.
//
// Three tiers (high / medium / low) instead of arbitrary floats:
//   - When every engine contributes equal RRF weight, a noisy low-recall
//     adapter (Lobsters when it 400s, MDN on a non-JS query) ranks
//     alongside a high-recall first-party docs API.
//   - Three discrete tiers give an unambiguous knob to label engines
//     without bike-shedding decimal weights per-engine.
//   - The mapping is monotonic: high > medium > low, so a high-tier engine's
//     rank-1 result outranks a low-tier engine's rank-1 result even with a
//     small RRF window (k=60).

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
 *  - bing / duckduckgo / bing_news: HTML scrapers, snippets are
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
  // Long-tail web engines: both run independent indexes and are
  // tagged `secondary` in the general vertical so they cannot dominate
  // consensus. Snippets tend to be sparse (Mojeek title+brief; Marginalia
  // small-web descriptions), so `low` matches the convention used for
  // lobsters/devdocs.
  mojeek: 'low',
  marginalia: 'low',
  // Image engines: image-search results carry source-page +
  // thumbnail/url + alt text rather than evidence-quality snippets. Tag as
  // `medium` so the RRF tuning treats them like the general medium pool
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
 * Tier → RRF weight mapping. High-tier engines (structured
 * first-party APIs) contribute full weight; low-tier engines (sparse
 * snippets, fallback-only payloads) contribute half. Medium sits between
 * so most scraped HTML engines stay close to today's behavior.
 *
 *   high   → 1.0
 *   medium → 0.7
 *   low    → 0.5
 */
export const QUALITY_WEIGHTS: Record<EngineQualityTier, number> = {
  high: 1.0,
  medium: 0.7,
  low: 0.5,
};

/**
 * RRF weight multiplier for a quality tier. S11c flips this from inert (1.0
 * for every tier) to the per-tier weights above so the orchestrator can
 * weight engine contributions by evidence quality.
 */
export function qualityRrfMultiplier(tier: EngineQualityTier): number {
  return QUALITY_WEIGHTS[tier];
}

/**
 * Resolve the effective RRF weight for an engine. Precedence:
 *   1. caller-supplied tier (e.g. EngineEntry.quality from S11b) — wins
 *      because the per-vertical entry is the most specific source of truth.
 *   2. quality tier (via the static registry above) — for engines that
 *      haven't been classified by a vertical-level entry yet.
 *   3. legacyWeight (per-vertical numeric override) — preserves existing
 *      behaviour for plugin engines that ship a custom weight.
 *   4. 1.0 default.
 *
 * This is what the orchestrator should call before fusing engine outcomes
 * — it keeps the tier lookup centralized so callers don't sprinkle
 * engineQualityTier() / qualityRrfMultiplier() throughout the pipeline.
 *
 * Forward-compat: an unknown tier string is treated as the safe default
 * (legacyWeight or 1.0) so a future extension to additional tiers
 * (e.g. 'premium') won't crash older orchestrator code in the field.
 */
export function resolveEngineWeight(
  name: string,
  legacyWeight?: number,
  callerTier?: EngineQualityTier | string,
): number {
  if (
    typeof callerTier === 'string' &&
    (callerTier === 'high' || callerTier === 'medium' || callerTier === 'low')
  ) {
    return QUALITY_WEIGHTS[callerTier];
  }
  const tier = ENGINE_QUALITY[name];
  if (tier !== undefined && tier in QUALITY_WEIGHTS) {
    return QUALITY_WEIGHTS[tier];
  }
  if (typeof legacyWeight === 'number' && Number.isFinite(legacyWeight)) {
    return legacyWeight;
  }
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
