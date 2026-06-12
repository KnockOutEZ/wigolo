import { BingEngine } from '../../engines/bing.js';
import { DuckDuckGoEngine } from '../../engines/duckduckgo.js';
import { WibyEngine } from '../../engines/wiby.js';
import { WikipediaEngine } from '../../engines/wikipedia.js';
import { BraveEngine } from '../../engines/brave.js';
import { MojeekEngine } from '../../engines/mojeek.js';
import { MarginaliaEngine } from '../../engines/marginalia.js';
import { wrapWithRetryAndBreaker, type EngineEntry } from '../engine-base.js';
import { getConfig } from '../../../config.js';

// Pool diversity matters more than weight precision: every additional
// independent lexical signal dilutes single-engine brand collisions (Bing's
// "next" → next.co.uk) once RRF fuses across the pool. Wikipedia adds a free
// authoritative signal; Brave joins only when an API key is configured so
// users without one see no behavior change.
let cached: EngineEntry[] | null = null;

export function getGeneralEngines(): EngineEntry[] {
  if (cached) return cached;

  const entries: EngineEntry[] = [
    { engine: wrapWithRetryAndBreaker(new BingEngine()), weight: 1, supportsDateFilter: false, quality: 'medium' },
    { engine: wrapWithRetryAndBreaker(new DuckDuckGoEngine()), weight: 1, supportsDateFilter: false, quality: 'medium' },
    { engine: wrapWithRetryAndBreaker(new WikipediaEngine()), weight: 0.6, supportsDateFilter: false, quality: 'high' },
    // Slice S11a: Mojeek runs its own independent web index (no Bing/Google
    // reliance), adding a real lexical signal that dilutes brand-collision
    // outcomes from the existing major-engine pool. Weight stays low and the
    // engine is marked `secondary` so it cannot dominate consensus when its
    // alignment with the query is weak. Quality tier `low` matches the
    // long-tail role from the S11b registry convention.
    { engine: wrapWithRetryAndBreaker(new MojeekEngine()), weight: 0.8, supportsDateFilter: false, secondary: true, quality: 'low' },
    // Slice S11a: Marginalia indexes the long-tail small web that the major
    // engines deprioritize. Same `secondary` rule as Mojeek — adds a niche
    // signal without dominating consensus.
    { engine: wrapWithRetryAndBreaker(new MarginaliaEngine()), weight: 0.6, supportsDateFilter: false, secondary: true, quality: 'low' },
    // Slice 3 (pool reshape): Wiby indexes the retro/personal small web —
    // long-tail recall the major engines miss. Lowest weight + `secondary`
    // so it adds coverage without ever dominating consensus. It replaces a
    // former scraper that required a stateful anti-bot token dance and never
    // contributed results.
    { engine: wrapWithRetryAndBreaker(new WibyEngine()), weight: 0.5, supportsDateFilter: false, secondary: true, quality: 'low' },
  ];

  if (getConfig().braveApiKey) {
    entries.push({ engine: wrapWithRetryAndBreaker(new BraveEngine()), weight: 1.1, supportsDateFilter: false, quality: 'medium' });
  }

  cached = entries;
  return cached;
}

export function _resetGeneralEnginesForTest(): void {
  cached = null;
}
