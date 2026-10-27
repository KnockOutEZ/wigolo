import type { BlockedInfo } from '../types.js';
import { isChallengeResponse, isNearEmptyBody } from './tls-tier.js';
import { detectAntiBotBlock } from '../extraction/site-extractors/reddit.js';

// "enable JavaScript and refresh" / "enable JavaScript to continue": the page says it cannot go on
// without JavaScript. A generic <noscript> notice ("for the best experience") does not say that.
const JS_WALL = /javascript[^.<]{0,60}(?:\band\s+(?:re)?(?:fresh|load)\b|\bto\s+(?:continue|proceed)\b)/i;

/**
 * Flag a body that came back as a block page instead of the real content, so
 * the fetch result can say so without turning into an error (issue #650).
 *
 * Reuses the existing detectors rather than adding markers:
 *   - 'challenge'   : the shared challenge classifier fires (vendor markers,
 *                     `cf-mitigated`, low-density wall at an anti-bot status).
 *                     This is checked first because a result with no body at
 *                     all, such as a PDF through the TLS tier, still has headers.
 *   - 'block_page'  : a near-empty body with an error status that carries a
 *                     known block banner ("blocked by network security",
 *                     "whoa there, partner").
 *   - 'js_required' : a near-empty body with an error status that says the
 *                     page cannot continue without JavaScript. At 2xx the same
 *                     stub is an ordinary SPA shell (already reported as
 *                     `js_required`), not a block.
 *
 * The text checks need a near-empty body and an error status, so a short page
 * that merely quotes a block phrase, or a real 404 with a generic <noscript>
 * notice, keeps its content unflagged.
 */
export function detectBlockedPage(
  statusCode: number,
  html: string | null | undefined,
  headers?: Record<string, string>,
): BlockedInfo | undefined {
  if (isChallengeResponse(statusCode, html, headers)) return { reason: 'challenge' };
  if (!html || !isNearEmptyBody(html)) return undefined;
  if (statusCode < 400) return undefined;
  if (detectAntiBotBlock(html)) return { reason: 'block_page' };
  if (JS_WALL.test(html.slice(0, 32768))) return { reason: 'js_required' };
  return undefined;
}
