import { describe, it, expect } from 'vitest';
import { classifyRisk, DEFAULT_RISK_PATTERNS, type RiskPatterns } from '../../../src/studio/risk.js';

/**
 * Phase 6c — the DETERMINISTIC risk classifier behind the approval gate. NOT an LLM judge:
 * an LLM classifier would itself read untrusted page content to decide, putting a
 * prompt-injectable component in charge of the injection defense. Code only.
 *
 * The load-bearing properties these tests pin:
 *  - Only the agent's ACTING verbs (click/type) are gateable; navigate/scroll/unknown are safe
 *    (navigation safety is the SSRF guard's job, not the money/credential/destructive gate).
 *  - HARD signals (host-observed URL) are weighted OVER the page-controlled element role/name:
 *    a malicious page cannot RENAME a risky control to a benign label to dodge the gate, and an
 *    absent/forged soft signal can never CLEAR a hard one. The soft signal can only RAISE risk.
 *  - Conservative: any matched signal gates; zero signal is safe (else co-browsing is unusable).
 */
describe('classifyRisk — deterministic risk tiers (the approval gate is code, not an LLM)', () => {
  it('scroll is never risky (scrolling cannot spend money, leak a credential, or destroy)', () => {
    expect(classifyRisk({ action: 'scroll' })).toBe('safe');
    expect(classifyRisk({ action: 'scroll', pageUrl: 'https://bank.example/transfer' })).toBe('safe');
  });

  it('navigate is not gated here — navigation safety is the SSRF guard, not the money/credential/destructive gate', () => {
    expect(classifyRisk({ action: 'navigate', pageUrl: 'https://shop.example/checkout' })).toBe('safe');
  });

  it('an unknown verb is safe for the classifier (it is refused upstream as action_not_supported)', () => {
    expect(classifyRisk({ action: 'frobnicate', pageUrl: 'https://shop.example/checkout' })).toBe('safe');
  });

  it('a click on a checkout/payment URL is money (hard, host-observed signal)', () => {
    expect(classifyRisk({ action: 'click', pageUrl: 'https://shop.example/checkout' })).toBe('money');
    expect(classifyRisk({ action: 'click', pageUrl: 'https://shop.example/payment/confirm' })).toBe('money');
  });

  it('a type on a login/sign-in URL is credential (hard signal)', () => {
    expect(classifyRisk({ action: 'type', pageUrl: 'https://acme.example/login' })).toBe('credential');
    expect(classifyRisk({ action: 'type', pageUrl: 'https://acme.example/account/security' })).toBe('credential');
  });

  it('a click on a delete/deactivate URL is destructive (hard signal)', () => {
    expect(classifyRisk({ action: 'click', pageUrl: 'https://acme.example/settings/delete-account' })).toBe('destructive');
    expect(classifyRisk({ action: 'click', pageUrl: 'https://acme.example/deactivate' })).toBe('destructive');
  });

  it('WEIGHTING: a hard URL signal is NOT suppressed by a benign page-controlled name (the page cannot rename its way out of the gate)', () => {
    // The checkout page renamed its submit button "Continue reading" to dodge a name-based gate.
    // The URL is host-observed and unspoofable → still money.
    expect(classifyRisk({ action: 'click', pageUrl: 'https://shop.example/checkout', role: 'button', name: 'Continue reading' })).toBe('money');
  });

  it('the SOFT role/name signal RAISES risk when the URL is silent (a "Pay $99.00" button on a plain URL)', () => {
    expect(classifyRisk({ action: 'click', pageUrl: 'https://blog.example/article', role: 'button', name: 'Pay $99.00' })).toBe('money');
  });

  it('a type into a field NAMED for a credential raises credential even on a plain URL', () => {
    expect(classifyRisk({ action: 'type', pageUrl: 'https://blog.example/article', role: 'textbox', name: 'Password' })).toBe('credential');
  });

  it('ZERO signal is safe — a plain click/type with no risky URL and no risky name does NOT gate (co-browsing must stay usable)', () => {
    expect(classifyRisk({ action: 'click', pageUrl: 'https://en.wikipedia.org/wiki/Cat', role: 'link', name: 'References' })).toBe('safe');
    expect(classifyRisk({ action: 'type', role: 'searchbox', name: 'Search' })).toBe('safe');
    expect(classifyRisk({ action: 'click' })).toBe('safe'); // nothing at all
  });

  it('an ABSENT soft signal cannot clear a hard gate (a money URL with no role/name is still money)', () => {
    expect(classifyRisk({ action: 'click', pageUrl: 'https://shop.example/checkout' })).toBe('money');
  });

  it('matching is case-insensitive (CHECKOUT / Checkout / checkout all gate)', () => {
    expect(classifyRisk({ action: 'click', pageUrl: 'https://shop.example/CHECKOUT' })).toBe('money');
    expect(classifyRisk({ action: 'click', pageUrl: 'https://shop.example/Checkout' })).toBe('money');
  });

  it('precedence is deterministic: when a URL matches more than one tier, credential wins (most sensitive)', () => {
    // /login (credential) AND /delete (destructive) in one path → credential, not destructive.
    expect(classifyRisk({ action: 'click', pageUrl: 'https://acme.example/login/delete-session' })).toBe('credential');
  });

  it('the pattern set is configurable: a custom URL gates under injected patterns but is safe under the default', () => {
    const custom: RiskPatterns = {
      url: { credential: [], money: [/\/launch-sequence\b/i], destructive: [] },
      element: { credential: [], money: [], destructive: [] },
    };
    expect(classifyRisk({ action: 'click', pageUrl: 'https://corp.example/launch-sequence' })).toBe('safe'); // default has no such rule
    expect(classifyRisk({ action: 'click', pageUrl: 'https://corp.example/launch-sequence' }, custom)).toBe('money');
  });

  it('the exported default pattern set actually carries the three tiers (it is the gate policy, not empty)', () => {
    expect(DEFAULT_RISK_PATTERNS.url.money.length).toBeGreaterThan(0);
    expect(DEFAULT_RISK_PATTERNS.url.credential.length).toBeGreaterThan(0);
    expect(DEFAULT_RISK_PATTERNS.url.destructive.length).toBeGreaterThan(0);
  });
});
