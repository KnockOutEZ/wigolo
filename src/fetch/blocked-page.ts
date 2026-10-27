import type { BlockedInfo } from '../types.js';
import { isChallengeResponse, isNearEmptyBody, looksJsRequired } from './tls-tier.js';
import { detectAntiBotBlock } from '../extraction/site-extractors/reddit.js';

/**
 * Flag a body that came back as a block page instead of the real content, so
 * the fetch result can say so without turning into an error (issue #650).
 *
 * Reuses the existing detectors rather than adding markers:
 *   - 'challenge'   : the shared challenge classifier fires (vendor markers,
 *                     `cf-mitigated`, low-density wall at an anti-bot status).
 *   - 'block_page'  : a near-empty body carrying a known block banner
 *                     ("blocked by network security", "whoa there, partner").
 *   - 'js_required' : a near-empty "enable JavaScript" stub served with an
 *                     error status. At 2xx the same stub is an ordinary SPA
 *                     shell (already reported as `js_required`), not a block.
 *
 * The text checks only run on a near-empty body, so an article that quotes a
 * block phrase keeps its prose and never trips.
 */
export function detectBlockedPage(
  statusCode: number,
  html: string | null | undefined,
  headers?: Record<string, string>,
): BlockedInfo | undefined {
  if (!html) return undefined;
  if (isChallengeResponse(statusCode, html, headers)) return { reason: 'challenge' };
  if (!isNearEmptyBody(html)) return undefined;
  if (detectAntiBotBlock(html)) return { reason: 'block_page' };
  if (statusCode >= 400 && looksJsRequired(html)) return { reason: 'js_required' };
  return undefined;
}
