import { describe, it, expect } from 'vitest';

import {
  COMPANION_ALLOW_HTTP_ENV,
  companionTransportRefusal,
} from '../../../src/cli/companion-transport-policy.js';

/**
 * The transport rule for the companion install, stated as a property.
 *
 * WHY THIS FILE EXISTS: `studio setup` fetches a release manifest and then executes what that
 * manifest points at. Over cleartext both hops are writable by anyone on the path, and the
 * digest the manifest carries proves nothing about a manifest the same attacker wrote — so the
 * ONLY defensible posture is that neither hop opens at all unless the transport is authenticated.
 * That is a decision about addresses, not about bytes, which is why it lives in its own module:
 * the refusal and the two call sites cannot drift into different ideas of "secure".
 *
 * Loopback is the one hole, and it is deliberately double-locked — loopback AND an explicit
 * environment opt-out — because the fixtures that exercise the install path are loopback servers
 * and nothing else should ever be able to reach through that hole.
 */
const ALLOW = { [COMPANION_ALLOW_HTTP_ENV]: '1' } as NodeJS.ProcessEnv;

describe('companionTransportRefusal', () => {
  it('permits https, to anywhere, with no opt-out needed', () => {
    expect(companionTransportRefusal('https://releases.example.com/companion/latest.json', {})).toBeNull();
    expect(companionTransportRefusal('https://127.0.0.1:8443/companion/latest.json', {})).toBeNull();
  });

  it('refuses plain http to a remote host even WITH the opt-out set', () => {
    // The opt-out exists for fixtures on this machine. If it also unlocked remote cleartext it
    // would be a switch that turns the whole control off, which is the control not existing.
    const refusal = companionTransportRefusal('http://releases.example.com/companion/latest.json', ALLOW);
    expect(refusal).not.toBeNull();
    expect(refusal).toContain('http://releases.example.com/companion/latest.json');
  });

  it('refuses plain http to loopback until the opt-out is set exactly', () => {
    const url = 'http://127.0.0.1:5599/companion/latest.json';
    expect(companionTransportRefusal(url, {})).not.toBeNull();
    // Not merely truthy: an opt-out that any non-empty value satisfies is one a stray `=0` opens.
    expect(companionTransportRefusal(url, { [COMPANION_ALLOW_HTTP_ENV]: '0' })).not.toBeNull();
    expect(companionTransportRefusal(url, { [COMPANION_ALLOW_HTTP_ENV]: 'true' })).not.toBeNull();
    expect(companionTransportRefusal(url, ALLOW)).toBeNull();
  });

  it('counts every spelling of this machine as loopback, and nothing else', () => {
    for (const host of ['localhost', 'dev.localhost', '127.0.0.1', '127.9.9.9', '[::1]']) {
      expect(companionTransportRefusal(`http://${host}/x`, ALLOW), host).toBeNull();
    }
    // A LAN address and a `.local` name are off this machine, whatever the user calls them.
    for (const host of ['192.168.1.10', 'build.local', '10.0.0.4', 'localhost.evil.example']) {
      expect(companionTransportRefusal(`http://${host}/x`, ALLOW), host).not.toBeNull();
    }
  });

  it('refuses a scheme that is neither https nor http, opt-out or not', () => {
    // `file:` would install whatever a manifest names on disk; `ftp:` is unauthenticated too.
    expect(companionTransportRefusal('file:///tmp/evil.dmg', ALLOW)).not.toBeNull();
    expect(companionTransportRefusal('ftp://releases.example.com/a.dmg', ALLOW)).not.toBeNull();
  });

  it('refuses an address it cannot parse rather than letting the transport guess', () => {
    expect(companionTransportRefusal('releases.example.com/latest.json', ALLOW)).not.toBeNull();
    expect(companionTransportRefusal('', ALLOW)).not.toBeNull();
  });

  it('names no implementation and tells the user what to change', () => {
    const refusal = companionTransportRefusal('http://releases.example.com/x.dmg', {}) ?? '';
    expect(refusal).toMatch(/encrypted|unencrypted|https/i);
    expect(refusal).not.toMatch(/playwright|electron|chromium|cdp/i);
  });
});
