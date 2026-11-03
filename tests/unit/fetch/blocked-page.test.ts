import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectBlockedPage } from '../../../src/fetch/blocked-page.js';

const fixture = (dir: string, name: string) =>
  readFileSync(join(__dirname, '../../fixtures', dir, name), 'utf-8');
const blockPage = (name: string) => fixture('blocked-pages', name);
const spaShell = (name: string) => fixture('spa-shells', name);

describe('detectBlockedPage', () => {
  describe('block pages', () => {
    it('flags the Reddit "blocked by network security" 403 as block_page', () => {
      expect(detectBlockedPage(403, blockPage('reddit-403.html'))).toEqual({ reason: 'block_page' });
    });

    it('flags the Quora 404 "enable Javascript" stub as js_required', () => {
      expect(detectBlockedPage(404, blockPage('quora-404-enable-js.html'))).toEqual({ reason: 'js_required' });
    });

    it('flags the Cloudflare "Attention Required!" 403 as challenge', () => {
      expect(detectBlockedPage(403, blockPage('cloudflare-403-blocked.html'))).toEqual({ reason: 'challenge' });
    });

    it('flags a 200 response marked by the cf-mitigated header as challenge', () => {
      const html = blockPage('short-ok.html');
      expect(detectBlockedPage(200, html, { 'cf-mitigated': 'challenge' })).toEqual({ reason: 'challenge' });
    });

    it('flags a response with no body at all when the cf-mitigated header marks a challenge', () => {
      // a PDF served through the TLS tier has empty html but keeps its headers
      expect(detectBlockedPage(200, '', { 'cf-mitigated': 'challenge' })).toEqual({ reason: 'challenge' });
      expect(detectBlockedPage(200, undefined, { 'CF-Mitigated': 'challenge' })).toEqual({ reason: 'challenge' });
    });

    it('flags "enable JavaScript to continue" on an error status as js_required', () => {
      const html = '<html><body><p>Please enable JavaScript to continue.</p></body></html>';
      expect(detectBlockedPage(403, html)).toEqual({ reason: 'js_required' });
    });

    it('flags the same notice when inline markup splits it', () => {
      const html = '<html><body><p>Please enable <b>JavaScript</b> to continue.</p></body></html>';
      expect(detectBlockedPage(404, html)).toEqual({ reason: 'js_required' });
    });

    it('flags a block banner when the status is only a placeholder (stealth mode)', () => {
      const html = blockPage('reddit-403.html');
      expect(detectBlockedPage(200, html, undefined, { statusUnknown: true })).toEqual({ reason: 'block_page' });
    });

    it('flags the 401 "enable JS" stub by DataDome\'s block flag as challenge', () => {
      // a 401 is not one of the anti-bot statuses the shared classifier trusts DataDome's headers on
      const headers = { 'x-dd-b': '1', 'x-datadome': 'protected' };
      expect(detectBlockedPage(401, blockPage('datadome-401.html'), headers)).toEqual({ reason: 'challenge' });
    });

    it('flags the same stub as js_required when the headers are gone', () => {
      expect(detectBlockedPage(401, blockPage('datadome-401.html'))).toEqual({ reason: 'js_required' });
    });
  });

  describe('normal pages (negative controls)', () => {
    it('does not flag a short ordinary 200 page', () => {
      expect(detectBlockedPage(200, blockPage('short-ok.html'))).toBeUndefined();
    });

    it('does not flag a short real 404 page', () => {
      expect(detectBlockedPage(404, blockPage('short-404.html'))).toBeUndefined();
    });

    it('does not flag a thin 200 page', () => {
      expect(detectBlockedPage(200, spaShell('thin-content.html'))).toBeUndefined();
    });

    it('does not flag a 200 SPA shell that asks for JavaScript', () => {
      expect(detectBlockedPage(200, spaShell('noscript-required.html'))).toBeUndefined();
    });

    it('does not flag a full article that quotes a block phrase', () => {
      const html = spaShell('normal-page.html').replace(
        '</article>',
        '<p>One reader reported seeing "blocked by network security" on another site.</p></article>',
      );
      expect(detectBlockedPage(200, html)).toBeUndefined();
    });

    it('does not flag a substantive 403 page', () => {
      expect(detectBlockedPage(403, spaShell('normal-page.html'))).toBeUndefined();
    });

    it('returns undefined for an empty body without a challenge header', () => {
      expect(detectBlockedPage(403, '')).toBeUndefined();
      expect(detectBlockedPage(200, '', {})).toBeUndefined();
    });

    it('does not flag a short 200 page that quotes a block phrase', () => {
      expect(detectBlockedPage(200, blockPage('short-quote.html'))).toBeUndefined();
    });

    it('still flags the same phrase as block_page on an error status', () => {
      expect(detectBlockedPage(403, blockPage('short-quote.html'))).toEqual({ reason: 'block_page' });
    });

    it('does not flag a short real 404 that has a generic noscript notice', () => {
      expect(detectBlockedPage(404, blockPage('short-404-noscript.html'))).toBeUndefined();
    });

    it('does not flag a short real 404 just because DataDome protects the site', () => {
      const html = blockPage('short-404.html');
      expect(detectBlockedPage(404, html, { 'x-datadome': 'protected' })).toBeUndefined();
      expect(detectBlockedPage(404, html, { 'x-dd-b': '0' })).toBeUndefined();
    });

    it('does not use DataDome\'s block flag on a 200', () => {
      expect(detectBlockedPage(200, blockPage('short-ok.html'), { 'x-dd-b': '1' })).toBeUndefined();
    });

    it('does not flag a substantive 401 page that carries the DataDome block flag', () => {
      // on a status the shared classifier does not cover, the flag only counts together with a near-empty body
      const html = `<html><body><p>${'The account page needs a sign-in. '.repeat(40)}</p></body></html>`;
      expect(detectBlockedPage(401, html, { 'x-dd-b': '1' })).toBeUndefined();
    });

    it('does not flag a short 403 from a sign-in gate, on purpose', () => {
      // "Access denied, sign in to view" is a login wall, not a bot check: the
      // page asks for credentials the caller can supply, so it is not a block page.
      expect(detectBlockedPage(403, blockPage('signin-403.html'))).toBeUndefined();
    });

    it('does not flag a block banner on a 200 the origin really returned', () => {
      expect(detectBlockedPage(200, blockPage('reddit-403.html'))).toBeUndefined();
    });

    it('does not flag a quoted block phrase when the status is only a placeholder', () => {
      const html = blockPage('short-quote.html');
      expect(detectBlockedPage(200, html, undefined, { statusUnknown: true })).toBeUndefined();
    });

    it('does not flag an ordinary short page when the status is only a placeholder', () => {
      const html = blockPage('short-ok.html');
      expect(detectBlockedPage(200, html, undefined, { statusUnknown: true })).toBeUndefined();
    });

    it('does not flag a JavaScript-required shell when the status is only a placeholder', () => {
      const html = spaShell('noscript-required.html');
      expect(detectBlockedPage(200, html, undefined, { statusUnknown: true })).toBeUndefined();
    });
  });
});
