import { DdgImageEngine } from '../../engines/ddg-image.js';
import { BraveImageEngine } from '../../engines/brave-image.js';
import { wrapWithRetryAndBreaker, type EngineEntry } from '../engine-base.js';
import { getConfig } from '../../../config.js';

// Images vertical for the core backend. Previously `category: 'images'`
// returned `unsupported_category` on
// `WIGOLO_SEARCH=core`. DDG Image is the zero-key critical path and ALWAYS
// runs; Brave Image is gated behind the existing BRAVE_API_KEY env var so
// users without one see no behavior change (and Brave's adapter raises a
// clear `BRAVE_API_KEY` error when the orchestrator forces a dispatch).
let cached: EngineEntry[] | null = null;

export function getImageEngines(): EngineEntry[] {
  if (cached) return cached;

  const entries: EngineEntry[] = [
    // DDG image: zero-key, HTML-bootstrapped vqd → i.js JSON. Higher weight
    // because it's the deterministic floor — without it, image search would
    // require Brave's API key to work at all.
    { engine: wrapWithRetryAndBreaker(new DdgImageEngine()), weight: 1.2, supportsDateFilter: false },
  ];

  // Brave image only joins when an API key is configured. Users without the
  // key see DDG-only image results; users WITH the key see fused results
  // ranked by RRF (same plumbing as the general vertical's Brave gating).
  if (getConfig().braveApiKey) {
    entries.push({ engine: wrapWithRetryAndBreaker(new BraveImageEngine()), weight: 1.2, supportsDateFilter: false });
  }

  cached = entries;
  return cached;
}

export function _resetImageEnginesForTest(): void {
  cached = null;
}
