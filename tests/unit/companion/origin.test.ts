import { describe, it, expect } from 'vitest';
import { normalizeOrigin } from '../../../src/companion/origin.js';

/**
 * EXTRACT A5 — public-side coverage for the split `normalizeOrigin` (spec §2.2's one split entry).
 *
 * This function is the KEY DERIVATION for the human's per-origin override store
 * (`companion/auth-origin-store.ts`) and for the per-origin drive budget. Everything asserted here
 * is therefore a statement about what counts as "the same site" when a human grants or refuses
 * something once and expects that answer to hold: too coarse and one grant covers a site the human
 * never saw, too fine and the grant they just gave is asked for again on the next page.
 *
 * Its coverage lived in `tests/unit/studio/authenticated-origin.test.ts`, which leaves with the
 * credential arc. This file is the coverage surviving that departure.
 */
describe('normalizeOrigin — the override store\'s key derivation', () => {
  it('drops path, query and fragment so every page of a site keys to one grant', () => {
    // A human grants a site once, from whichever page they happened to be on. If the path rode into
    // the key, the next page on the same site would be an unrecognized origin and would ask again.
    expect(normalizeOrigin('https://example.com/login?next=%2Fdash#top')).toBe('https://example.com');
    expect(normalizeOrigin('https://example.com/')).toBe('https://example.com');
    expect(normalizeOrigin('https://example.com')).toBe('https://example.com');
  });

  it('is idempotent, so a stored key re-normalizes to itself', () => {
    // The store reads keys back and normalizes caller input before comparing. A normalizer that
    // changed its own output would miss every previously-stored grant.
    for (const raw of ['https://example.com/a', 'http://localhost:3000/x', 'https://example.com:8443/y']) {
      const once = normalizeOrigin(raw);
      expect(once).not.toBeNull();
      expect(normalizeOrigin(once as string)).toBe(once);
    }
  });

  it('lowercases the host, because DNS does not care about case and neither may the key', () => {
    // Otherwise `HTTPS://Example.com` and `https://example.com` are two grants for one site.
    expect(normalizeOrigin('HTTPS://Example.COM/Path')).toBe('https://example.com');
  });

  it('elides the default port but keeps a non-default one', () => {
    // `https://example.com:443` IS `https://example.com` — the same server, so the same grant.
    expect(normalizeOrigin('https://example.com:443/x')).toBe('https://example.com');
    expect(normalizeOrigin('http://example.com:80/x')).toBe('http://example.com');
    // A different port is a different origin to the browser, so it must be a different grant: the
    // dev server on :8443 is not the site on :443.
    expect(normalizeOrigin('https://example.com:8443/x')).toBe('https://example.com:8443');
  });

  it('keeps scheme in the key, so a grant on https never covers http', () => {
    // Downgrading to plaintext is exactly the case a human would want asked again.
    expect(normalizeOrigin('http://example.com')).toBe('http://example.com');
    expect(normalizeOrigin('https://example.com')).toBe('https://example.com');
    expect(normalizeOrigin('http://example.com')).not.toBe(normalizeOrigin('https://example.com'));
  });

  it('keeps subdomains distinct', () => {
    expect(normalizeOrigin('https://app.example.com')).toBe('https://app.example.com');
    expect(normalizeOrigin('https://app.example.com')).not.toBe(normalizeOrigin('https://example.com'));
  });

  it('returns null for an OPAQUE origin rather than the string "null"', () => {
    // This is the arm that matters most. `new URL('data:...').origin` is the literal text 'null',
    // and so is a sandboxed frame's. Passing that through would give every unrelated opaque origin
    // ONE shared store key: a grant made against one data: document would silently answer for the
    // next. Null means "not a keyable origin" and the caller skips it.
    expect(normalizeOrigin('data:text/html,<p>hi')).toBeNull();
    expect(normalizeOrigin('data:text/plain,other')).toBeNull();
  });

  it('returns null, never throws, for input that is not an absolute URL', () => {
    // Callers feed it host-reported strings; a throw here would take out a store read.
    for (const bad of ['not a url', '/relative/path', 'example.com', '', '   ', 'https://']) {
      expect(normalizeOrigin(bad)).toBeNull();
    }
  });
});
