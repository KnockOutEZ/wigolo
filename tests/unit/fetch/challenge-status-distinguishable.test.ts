import { describe, it, expect } from 'vitest';
import { isChallengeShell, isLowContentDensity } from '../../../src/fetch/tls-tier.js';

/**
 * The vendor-agnostic wall-shape rule relabels a large, all-scaffolding body
 * served with an anti-bot status as `blocked_by_challenge` rather than
 * `http_403`. That is deliberate — a marker catalog only recognises walls we
 * have already met — but it means a caller can no longer read the error CODE to
 * learn what the origin actually said.
 *
 * The contract that makes it safe: whenever a real anti-bot status exists it is
 * still surfaced as `http_status`, so a genuine 403 stays distinguishable from a
 * challenge served at 200. That also matters mechanically — the crawl adaptive
 * cooldown keys on 403/429, so dropping the status would silently disable it.
 *
 * These pin both halves. Without them the relabel could quietly swallow the
 * status and nothing would notice.
 */

const SCAFFOLD = `<html><head>${'<script src="/a.js"></script>'.repeat(60)}</head><body><div id="x"></div></body></html>`;
const REAL_403_PAGE =
  '<html><body><h1>Forbidden</h1><p>' +
  'You do not have permission to view this resource. Contact your administrator. '.repeat(20) +
  '</p></body></html>';

/**
 * A LARGE real page whose first 32KB is `<head>` scripts and stylesheets — the
 * normal shape of any modern site, and the case the original fixture was too
 * small to reach. challenge-classify.ts already documents this trap: walmart's
 * 405KB page carries <600 visible chars in its first 32KB but 2,777 overall, so
 * judging density on a leading slice calls a real page empty.
 */
const BIG_REAL_403_PAGE =
  '<html><head>' +
  '<script src="/static/chunk.js"></script><link rel="stylesheet" href="/a.css">'.repeat(420) +
  '</head><body>' +
  '<p>Access to this administrative area is restricted to authorised staff. Contact your administrator to request access. '.repeat(300) +
  '</p></body></html>';

describe('the wall-shape rule keeps a real anti-bot status distinguishable', () => {
  it('treats a large all-scaffolding body as low density', () => {
    expect(isLowContentDensity(SCAFFOLD)).toBe(true);
  });

  it('does NOT treat a substantive error page as low density', () => {
    expect(isLowContentDensity(REAL_403_PAGE)).toBe(false);
  });

  it('does NOT misjudge a LARGE real page whose first 32KB is head scripts', () => {
    // Regression: density was measured on html.slice(0, 32768). Any modern
    // page's leading 32KB is head assets, so a genuinely substantive body read
    // as empty and a real 403 was relabelled a bot wall.
    expect(isLowContentDensity(BIG_REAL_403_PAGE)).toBe(false);
    expect(isChallengeShell(403, BIG_REAL_403_PAGE)).toBe(false);
  });

  it('still catches a LARGE wall — size alone must not buy a pass', () => {
    // The mirror of the case above: a big page that is genuinely all
    // scaffolding is still a wall, so the fix cannot be "ignore large pages".
    const bigWall =
      '<html><head>' +
      '<script src="/px.js"></script><link rel="stylesheet" href="/a.css">'.repeat(900) +
      '</head><body><div id="challenge"></div></body></html>';
    expect(isLowContentDensity(bigWall)).toBe(true);
    expect(isChallengeShell(403, bigWall)).toBe(true);
  });

  it('needs BOTH an anti-bot status and low density — status alone is not a wall', () => {
    // A substantive 403 (an admin page saying "forbidden") must pass through as
    // an ordinary HTTP error, not get relabelled a challenge.
    expect(isChallengeShell(403, REAL_403_PAGE)).toBe(false);
  });

  it('needs BOTH — low density alone is not a wall either', () => {
    // An un-hydrated SPA shell at 200 is the normal shape of a JS app booting.
    expect(isChallengeShell(200, SCAFFOLD)).toBe(false);
  });

  it('fires only when the two coincide', () => {
    expect(isChallengeShell(403, SCAFFOLD)).toBe(true);
    expect(isChallengeShell(429, SCAFFOLD)).toBe(true);
    expect(isChallengeShell(503, SCAFFOLD)).toBe(true);
  });

  it('ignores a body too small for the density ratio to mean anything', () => {
    // A 30-byte error body's ratio is noise, not signal.
    expect(isLowContentDensity('<html><body></body></html>')).toBe(false);
    expect(isChallengeShell(403, '<html><body></body></html>')).toBe(false);
  });
});
