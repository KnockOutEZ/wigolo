import { describe, it, expect } from 'vitest';
import {
  isRegistrableDomain,
  registrableDomain,
  type RegistrableDomain,
} from '../../../src/telemetry/domain.js';

describe('registrableDomain', () => {
  it('reduces a full URL to eTLD+1, dropping path, query and fragment', () => {
    expect(registrableDomain('https://news.example.com/a/b?q=secret#frag')).toBe('example.com');
  });

  it('handles multi-part public suffixes — the co.uk case', () => {
    const domain: RegistrableDomain | null = registrableDomain('https://shop.checkout.example.co.uk/basket');
    expect(domain).toBe('example.co.uk');
    expect(registrableDomain('example.co.uk')).toBe('example.co.uk');
    expect(registrableDomain('a.b.c.example.co.uk')).toBe('example.co.uk');
    expect(registrableDomain('sub.example.com.au')).toBe('example.com.au');
    expect(registrableDomain('deep.pages.github.io')).toBe('github.io');
  });

  it('reduces a bare hostname too', () => {
    expect(registrableDomain('www.example.com')).toBe('example.com');
    expect(registrableDomain('EXAMPLE.COM')).toBe('example.com');
  });

  it('returns null where there is no registrable domain to report', () => {
    for (const input of ['', 'localhost', '192.168.1.7', '::1', 'co.uk', 'not a host', '/etc/passwd']) {
      expect(registrableDomain(input), JSON.stringify(input)).toBeNull();
    }
  });

  it('never returns more labels than the registrable domain has', () => {
    // The whole reason this exists: `new URL(u).hostname` would ship the subdomains too.
    const url = 'https://a.b.c.example.co.uk/x';
    expect(new URL(url).hostname).toBe('a.b.c.example.co.uk');
    expect(registrableDomain(url)).toBe('example.co.uk');
  });
});

describe('isRegistrableDomain', () => {
  it('accepts a bare, already-reduced domain', () => {
    for (const value of ['example.com', 'example.co.uk', 'github.io']) {
      expect(isRegistrableDomain(value), value).toBe(true);
    }
  });

  it('rejects anything that is not already its own eTLD+1', () => {
    const rejected = [
      'www.example.com',
      'https://example.com',
      'example.com/path',
      'example.com:8443',
      'example.com?q=1',
      'EXAMPLE.COM',
      ' example.com',
      'user@example.com',
      'two words',
      '/Users/me/file.md',
      'localhost',
      '10.0.0.1',
      '',
    ];
    for (const value of rejected) {
      expect(isRegistrableDomain(value), JSON.stringify(value)).toBe(false);
    }
  });

  it('rejects non-strings', () => {
    for (const value of [null, undefined, 42, {}, ['example.com']]) {
      expect(isRegistrableDomain(value)).toBe(false);
    }
  });

  it('accepts exactly what registrableDomain produces, for every producible value', () => {
    for (const url of ['https://a.b.example.co.uk/x?y=1', 'http://www.example.com', 'sub.github.io']) {
      const reduced = registrableDomain(url);
      expect(reduced).not.toBeNull();
      expect(isRegistrableDomain(reduced), url).toBe(true);
    }
  });
});
