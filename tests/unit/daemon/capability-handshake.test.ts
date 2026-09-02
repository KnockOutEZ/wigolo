import { describe, it, expect } from 'vitest';
import {
  ALL_CAPABILITIES,
  DETECTED_CLIENT_TABLE,
  MAX_CLIENT_FIELD_CHARS,
  UNKNOWN_CLIENT_PROFILE,
  clientAttachedEvent,
  currentClientProfile,
  hasCapability,
  profileClient,
  withClientProfile,
  type Capability,
} from '../../../src/daemon/capability-handshake.js';

/**
 * SD2 mini-spec §2. The load-bearing claim is law 5: the client NAME may select phrasing and
 * nothing else. Every arm below that compares two profiles exists to red the moment a name buys
 * behaviour, because that is the failure this table is shaped to prevent.
 */
describe('profileClient — the detected-tier mapping table (§2.2)', () => {
  it('maps every table row to its phrasing key, prefix-matched and case-insensitively', () => {
    for (const row of DETECTED_CLIENT_TABLE) {
      expect(profileClient({ name: row.prefix, version: '1.0.0' }).phrasing).toBe(row.phrasing);
      expect(profileClient({ name: row.prefix.toUpperCase(), version: '1.0.0' }).phrasing).toBe(row.phrasing);
      // A harness ships its name with a suffix far more often than bare: `claude-code-cli`, `cursor-ide`.
      expect(profileClient({ name: `${row.prefix}-nightly`, version: '1.0.0' }).phrasing).toBe(row.phrasing);
    }
  });

  it('sends an unmapped harness to the safe default rather than to an error (§2.2 pin, A-51-9)', () => {
    const fabricated = profileClient({ name: 'foo-agent', version: '0.3' });
    expect(fabricated.phrasing).toBe('generic');
    expect(fabricated.capabilities).toEqual([]);
    expect(fabricated.client).toEqual({ name: 'foo-agent', version: '0.3' });
  });

  it('sends an absent or malformed handshake to the safe default, still without throwing', () => {
    for (const raw of [undefined, null, 'claude-code', 42, [], {}, { name: '' }, { name: '   ', version: '1' }]) {
      const p = profileClient(raw as never);
      expect(p.phrasing).toBe('generic');
      expect(p.capabilities).toEqual([]);
    }
    expect(profileClient(undefined)).toEqual(UNKNOWN_CLIENT_PROFILE);
  });

  it('omits the client badge unless BOTH name and version arrived, mirroring the run log`s own rule', () => {
    // run-store.ts `clientOf` drops a half-filled badge; a profile that kept one would serialize a
    // shape the log itself refuses, into the very payload the log stores.
    expect(profileClient({ name: 'foo-agent' } as never).client).toBeUndefined();
    expect(profileClient({ version: '1.0' } as never).client).toBeUndefined();
    expect(profileClient({ name: 'foo-agent', version: '1.0' }).client).toEqual({ name: 'foo-agent', version: '1.0' });
  });

  it('caps both badge fields — the handshake is wire input written into an append-only log', () => {
    const p = profileClient({ name: 'x'.repeat(MAX_CLIENT_FIELD_CHARS + 50), version: 'y'.repeat(MAX_CLIENT_FIELD_CHARS + 50) });
    expect(p.client?.name).toHaveLength(MAX_CLIENT_FIELD_CHARS);
    expect(p.client?.version).toHaveLength(MAX_CLIENT_FIELD_CHARS);
  });
});

describe('the detected tier grants NO capability to anyone (§2.2)', () => {
  it('hands every mapped harness an empty capability set', () => {
    // MCP is a pull transport and `clientInfo` is self-reported: it cannot prove push, mid-flight
    // interrupt, resume or identity. This arm reds if a row is ever given a capability at THIS tier
    // — SD8's adopted/wrapped ceilings are a different tier and must not leak backwards into it.
    for (const row of DETECTED_CLIENT_TABLE) {
      const p = profileClient({ name: row.prefix, version: '1.0.0' });
      expect(p.tier).toBe('detected');
      expect(p.capabilities).toEqual([]);
      for (const cap of ALL_CAPABILITIES) expect(hasCapability(p, cap)).toBe(false);
    }
  });

  it('enumerates all six capability names so a seventh cannot be added unnoticed', () => {
    expect([...ALL_CAPABILITIES].sort()).toEqual(
      (['identity', 'interrupt', 'narrate', 'push', 'reasoning', 'resume'] satisfies Capability[]).sort(),
    );
  });

  it('reports absent capabilities for the unknown default too', () => {
    for (const cap of ALL_CAPABILITIES) expect(hasCapability(UNKNOWN_CLIENT_PROFILE, cap)).toBe(false);
  });
});

describe('law 5 — a name buys phrasing and nothing else', () => {
  it('leaves a fabricated harness and a mapped one differing ONLY in phrasing and the badge', () => {
    const known = profileClient({ name: 'claude-code', version: '1.0.0' });
    const fabricated = profileClient({ name: 'foo-agent', version: '1.0.0' });

    const behavioural = (p: typeof known) => ({ tier: p.tier, capabilities: [...p.capabilities] });
    expect(behavioural(fabricated)).toEqual(behavioural(known));
    expect(fabricated.phrasing).not.toBe(known.phrasing);
  });

  it('keeps the mapping total — no input produces a third phrasing key', () => {
    const keys = new Set(
      ['claude-code', 'cursor', 'windsurf', 'cline', 'codex', 'gemini', 'claude', 'foo-agent', '', 'Ω'].map(
        (name) => profileClient({ name, version: '1' }).phrasing,
      ),
    );
    expect([...keys].sort()).toEqual(['generic', 'mcp-tools']);
  });
});

describe('the ambient profile seam — queryable wherever a result is phrased', () => {
  it('answers with the safe default outside any connection scope', () => {
    expect(currentClientProfile()).toEqual(UNKNOWN_CLIENT_PROFILE);
  });

  it('answers with the connection`s profile inside its scope, across an await', async () => {
    const profile = profileClient({ name: 'cursor', version: '2.0' });
    const seen = await withClientProfile(profile, async () => {
      await new Promise((r) => setTimeout(r, 1));
      return currentClientProfile();
    });
    expect(seen).toEqual(profile);
    expect(currentClientProfile()).toEqual(UNKNOWN_CLIENT_PROFILE);
  });

  it('keeps two concurrent connections from reading each other`s profile', async () => {
    const a = profileClient({ name: 'claude-code', version: '1' });
    const b = profileClient({ name: 'foo-agent', version: '1' });
    const read = (p: typeof a, delay: number) =>
      withClientProfile(p, async () => {
        await new Promise((r) => setTimeout(r, delay));
        return currentClientProfile();
      });
    // b resolves FIRST — a shared mutable "current profile" would hand a the value b left behind.
    const [seenA, seenB] = await Promise.all([read(a, 8), read(b, 1)]);
    expect(seenA).toEqual(a);
    expect(seenB).toEqual(b);
  });
});

describe('clientAttachedEvent — the run-log record of an attach', () => {
  it('mints a `client.attached` event carrying the whole profile', () => {
    const profile = profileClient({ name: 'claude-code', version: '1.0.0' });
    const event = clientAttachedEvent(profile);
    expect(event.type).toBe('client.attached');
    expect(event.payload).toEqual({
      tier: 'detected',
      phrasing: 'mcp-tools',
      capabilities: [],
      client: { name: 'claude-code', version: '1.0.0' },
    });
  });

  it('names the client as the actor, and claims no driver kind — the baton is not this issue`s', () => {
    const event = clientAttachedEvent(profileClient({ name: 'foo-agent', version: '1' }));
    expect(event.actor).toEqual({ kind: 'agent', client: { name: 'foo-agent', version: '1' } });
    expect(event.actor).not.toHaveProperty('driver');
  });

  it('omits the badge, not the event, when the handshake carried no client', () => {
    const event = clientAttachedEvent(UNKNOWN_CLIENT_PROFILE);
    expect(event.payload).toEqual({ tier: 'detected', phrasing: 'generic', capabilities: [] });
    expect(event.actor).toEqual({ kind: 'agent' });
  });

  it('satisfies the run store`s event-type grammar', () => {
    // `client.attached` must be appendable and streamable without an enum edit; the grammar is the
    // only gate, and `tab.attached` already owns the neighbouring name.
    expect(clientAttachedEvent(UNKNOWN_CLIENT_PROFILE).type).toMatch(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
    expect(clientAttachedEvent(UNKNOWN_CLIENT_PROFILE).type).not.toBe('tab.attached');
  });
});
