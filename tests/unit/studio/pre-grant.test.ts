import { describe, it, expect } from 'vitest';
import { PreGrantStore, deriveDomain } from '../../../src/studio/pre-grant.js';

/**
 * S7 — the pre-grant scope store. EMPTY by default (fail-closed); matching requires domain AND actionType AND
 * riskTier; an unreadable domain never matches. The WRITE boundary (only the {t:'grant'} WS-human handler) is
 * enforced at the host wiring (cli/studio) — pinned there.
 */
describe('studio PreGrantStore', () => {
  const entry = { domain: 'shop.example', actionType: 'click', riskTier: 'money' as const };

  it('is EMPTY by default and matches nothing (the fail-closed baseline)', () => {
    const s = new PreGrantStore();
    expect(s.size).toBe(0);
    expect(s.matches({ domain: 'shop.example', actionType: 'click', riskTier: 'money' })).toBe(false);
  });

  it('matches only when domain AND actionType AND riskTier all align', () => {
    const s = new PreGrantStore();
    s.add(entry);
    expect(s.matches({ domain: 'shop.example', actionType: 'click', riskTier: 'money' })).toBe(true);
    expect(s.matches({ domain: 'other.example', actionType: 'click', riskTier: 'money' })).toBe(false); // wrong domain
    expect(s.matches({ domain: 'shop.example', actionType: 'type', riskTier: 'money' })).toBe(false); // wrong action
    expect(s.matches({ domain: 'shop.example', actionType: 'click', riskTier: 'credential' })).toBe(false); // wrong tier
  });

  it('fail-closed: an undefined domain never matches', () => {
    const s = new PreGrantStore();
    s.add(entry);
    expect(s.matches({ domain: undefined, actionType: 'click', riskTier: 'money' })).toBe(false);
  });

  it('add is idempotent; revoke + clear remove grants', () => {
    const s = new PreGrantStore();
    s.add(entry);
    s.add({ ...entry });
    expect(s.size).toBe(1); // not duplicated
    s.revoke({ ...entry });
    expect(s.size).toBe(0);
    s.add(entry);
    s.clear();
    expect(s.size).toBe(0);
  });

  it('deriveDomain returns the hostname or undefined (fail-closed) on an unparseable url', () => {
    expect(deriveDomain('https://shop.example/checkout?x=1')).toBe('shop.example');
    expect(deriveDomain('http://127.0.0.1:8080/p')).toBe('127.0.0.1');
    expect(deriveDomain(undefined)).toBeUndefined();
    expect(deriveDomain('not a url')).toBeUndefined();
  });
});
