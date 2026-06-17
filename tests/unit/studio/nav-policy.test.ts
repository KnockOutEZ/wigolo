import { describe, it, expect } from 'vitest';
import { policyForHolder, type NavGrant } from '../../../src/studio/nav-policy.js';
import { guardNavigation } from '../../../src/security/ssrf.js';

const denyAll: NavGrant = { humanAllowPrivate: false, agentAllowPrivate: false };
const humanLocal: NavGrant = { humanAllowPrivate: true, agentAllowPrivate: false };
const granted: NavGrant = { humanAllowPrivate: true, agentAllowPrivate: true };

describe('policyForHolder — maps the control-token holder to the nav policy', () => {
  it('human → source:human with the human grant (co-browsing a local dev server)', () => {
    expect(policyForHolder('human', humanLocal)).toEqual({ source: 'human', allowPrivate: true });
    expect(policyForHolder('human', denyAll)).toEqual({ source: 'human', allowPrivate: false });
  });

  it('agent → source:agent, DEFAULT-DENY for private/localhost (no self-grant possible)', () => {
    // The fail-closed default IS the default — not an opt-out. With no grant the agent
    // policy blocks loopback/RFC1918.
    expect(policyForHolder('agent', humanLocal)).toEqual({ source: 'agent', allowPrivate: false });
    expect(policyForHolder('agent', denyAll)).toEqual({ source: 'agent', allowPrivate: false });
  });

  it('agent + explicit grant → source:agent with allowPrivate (the one controlled hole)', () => {
    expect(policyForHolder('agent', granted)).toEqual({ source: 'agent', allowPrivate: true });
  });
});

describe('the per-session grant lifts loopback/RFC1918 ONLY — cloud-metadata stays blocked (CEO lock)', () => {
  it('no grant → the agent is blocked from localhost/RFC1918 (fail-closed default)', () => {
    const pol = policyForHolder('agent', denyAll);
    expect(guardNavigation('http://localhost:3000/', pol).ok).toBe(false);
    expect(guardNavigation('http://127.0.0.1/', pol).ok).toBe(false);
    expect(guardNavigation('http://10.0.0.5/', pol).ok).toBe(false);
    expect(guardNavigation('http://192.168.1.10/', pol).ok).toBe(false);
  });

  it('WITH the grant → the agent reaches localhost/RFC1918 (the dev-server co-browse case)', () => {
    const pol = policyForHolder('agent', granted);
    expect(guardNavigation('http://localhost:3000/', pol).ok).toBe(true);
    expect(guardNavigation('http://10.0.0.5/', pol).ok).toBe(true);
    expect(guardNavigation('http://192.168.1.10/', pol).ok).toBe(true);
  });

  it('cloud-metadata + cloud-internal stay BLOCKED for the agent EVEN UNDER the grant (no SSRF lane)', () => {
    const pol = policyForHolder('agent', granted); // grant ON
    expect(guardNavigation('http://169.254.169.254/latest/meta-data/', pol).ok).toBe(false);
    expect(guardNavigation('http://metadata.google.internal/', pol).ok).toBe(false);
    expect(guardNavigation('http://[64:ff9b::a9fe:a9fe]/', pol).ok).toBe(false); // NAT64-embedded metadata
  });

  it('cloud-metadata stays blocked for the HUMAN too, regardless of the human grant', () => {
    const pol = policyForHolder('human', granted);
    expect(guardNavigation('http://169.254.169.254/', pol).ok).toBe(false);
    expect(guardNavigation('http://localhost/', pol).ok).toBe(true); // but localhost is fine for the human
  });
});
