/**
 * Public surface of `src/fetch/` for the companion split (`wigolo/fetch-tiers`).
 *
 * The tier primitives the extracted studio domain layer reuses so it classifies a
 * challenge the same way core's ladder does — not the fetch subsystem's barrel.
 */
export { isChallengeShell } from './tls-tier.js';
export { classifyChallenge } from './challenge-classify.js';
export { requireBrowserDriver } from './browser-driver.js';

// `human-solve-bridge.ts` — the cookie shape a solved challenge hands back.
export { type ClearanceCookie } from './challenge-completion.js';
