import type { BlockedInfo } from '../types.js';
import { isChallengeResponse, isNearEmptyBody } from './tls-tier.js';
import { detectAntiBotBlock } from '../extraction/site-extractors/reddit.js';

// "enable JavaScript and refresh" / "enable JS to continue" / "enable JS and disable any ad blocker": the
// page says it cannot go on without JavaScript. A generic <noscript> notice ("for the best experience")
// does not say that.
const JS_WALL = /\b(?:javascript|js)\b[^.]{0,60}(?:\band\s+(?:(?:re)?(?:fresh|load)|disable)\b|\bto\s+(?:continue|proceed)\b)/i;

export interface BlockedPageOptions {
  /** The status code is a placeholder: the fetch tier never saw the origin's status. */
  statusUnknown?: boolean;
}

/**
 * DataDome's explicit block flag. Only `x-dd-b` counts here, so a near-empty real 404 from a site that
 * DataDome protects stays unflagged.
 */
function hasDataDomeBlockFlag(headers: Record<string, string> | undefined): boolean {
  if (!headers) return false;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== 'x-dd-b') continue;
    const v = (value ?? '').trim();
    if (v !== '' && v !== '0') return true;
  }
  return false;
}

/** The visible text of a page, so a notice split by inline markup (`enable <b>JavaScript</b>`) still reads as one. */
function visibleText(html: string): string {
  return html
    .slice(0, 32768)
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Text with the passages inside double quotation marks removed: someone quoting a block message is not blocked. */
function withoutQuotedPassages(text: string): string {
  return text.replace(/["“][^"“”]{1,200}["”]/g, ' ');
}

/**
 * Flag a body that came back as a block page instead of the real content, so
 * the fetch result can say so without turning into an error (issue #650).
 *
 * Reuses the existing detectors rather than adding markers:
 *   - 'challenge'   : the shared challenge classifier fires (vendor markers,
 *                     `cf-mitigated`, low-density wall at an anti-bot status).
 *                     This is checked first because a result with no body at
 *                     all, such as a PDF through the TLS tier, still has headers.
 *   - 'block_page'  : a near-empty body that carries a known block banner
 *                     ("blocked by network security", "whoa there, partner").
 *   - 'js_required' : a near-empty body that says the page cannot continue
 *                     without JavaScript. At 2xx the same stub is an ordinary
 *                     SPA shell (already reported as `js_required`), not a block.
 *
 * The text checks need a near-empty body, and a status that makes sense of it:
 *   - An error status: both checks run.
 *   - A 2xx status the origin really returned: neither runs, so a short page
 *     that merely quotes a block phrase keeps its content unflagged.
 *   - A placeholder status (`statusUnknown`, as in stealth mode): only the
 *     banner check runs, and a banner inside quotation marks is ignored. The
 *     JavaScript check stays off because it cannot tell a SPA shell from a block.
 */
export function detectBlockedPage(
  statusCode: number,
  html: string | null | undefined,
  headers?: Record<string, string>,
  options?: BlockedPageOptions,
): BlockedInfo | undefined {
  if (isChallengeResponse(statusCode, html, headers)) return { reason: 'challenge' };
  if (!html || !isNearEmptyBody(html)) return undefined;

  const text = visibleText(html);
  if (statusCode >= 400) {
    // The shared classifier trusts DataDome's headers only on 403, 429 and 503, but it also answers
    // with a 401 and a near-empty "enable JS" stub.
    if (hasDataDomeBlockFlag(headers)) return { reason: 'challenge' };
    if (detectAntiBotBlock(html)) return { reason: 'block_page' };
    if (JS_WALL.test(text)) return { reason: 'js_required' };
    return undefined;
  }
  if (options?.statusUnknown && detectAntiBotBlock(withoutQuotedPassages(text))) {
    return { reason: 'block_page' };
  }
  return undefined;
}
