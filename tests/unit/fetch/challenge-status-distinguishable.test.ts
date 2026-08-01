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

describe('the wall-shape rule keeps a real anti-bot status distinguishable', () => {
  it('treats a large all-scaffolding body as low density', () => {
    expect(isLowContentDensity(SCAFFOLD)).toBe(true);
  });

  it('does NOT treat a substantive error page as low density', () => {
    expect(isLowContentDensity(REAL_403_PAGE)).toBe(false);
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
