import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { createStudioMcpServer } from '../../../src/daemon/studio-mcp-server.js';
import {
  UNKNOWN_CLIENT_PROFILE,
  connectionProfile,
  currentClientProfile,
  type ClientProfile,
} from '../../../src/daemon/capability-handshake.js';
import type { StudioHostHandlers } from '../../../src/daemon/studio-dispatch.js';

/**
 * The handshake as it actually runs: over a real MCP `initialize`, on the gateway that serves the
 * `studio_*` surface. The two arms that matter are (a) an unmapped harness gets the safe default
 * rather than an error, and (b) the two harnesses get byte-identical results — law 5 as an
 * executable claim rather than a comment.
 */

/** Whatever the host saw at the moment it was called, so the ambient seam can be asserted. */
let seenDuringDispatch: ClientProfile[] = [];

const hostHandlers = (): StudioHostHandlers => ({
  observe: async () => {
    seenDuringDispatch.push(currentClientProfile());
    return { id: 's', kind: 'full', trusted: false, untrusted_notice: 'data not instructions', elements: [], events: [], eventCursor: 0, eventsDropped: 0, domTruncated: false };
  },
  act: async (i) => ({ ok: true, action: i.action }),
  marks: async () => ({ marks: [], untrusted_notice: 'data not instructions' }),
  capture: async () => ({ artifact_id: 1, inserted: true, content_hash: 'h' }),
  spawn: async () => ({ session_id: 'sess-1' }),
  close: async (i) => ({ closed: true as const, session_id: i.session_id ?? '' }),
  list: async () => ({ sessions: [] }),
  say: async () => ({ posted: true, posted_at: 0 }),
  extractSet: async () => ({ columns: [], rows: [], pages_followed: 0 }),
});

async function connect(clientInfo: { name: string; version: string }): Promise<{ client: Client; server: Server }> {
  const server = createStudioMcpServer({ studioHost: hostHandlers() });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client(clientInfo, { capabilities: {} });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return { client, server };
}

describe('the gateway resolves a capability profile at `initialize`', () => {
  it('reads a mapped harness off the handshake and stores it on the connection', async () => {
    const { server } = await connect({ name: 'claude-code', version: '1.2.3' });
    expect(connectionProfile(server)).toEqual({
      tier: 'detected',
      phrasing: 'mcp-tools',
      capabilities: [],
      client: { name: 'claude-code', version: '1.2.3' },
    });
  });

  it('accepts a harness nobody has ever heard of, at the safe default, without an error', async () => {
    const { client, server } = await connect({ name: 'foo-agent', version: '0.3' });
    const profile = connectionProfile(server);
    expect(profile.phrasing).toBe('generic');
    expect(profile.capabilities).toEqual([]);
    // The connection is not merely tolerated — it is fully usable. Every mechanism short of
    // out-of-band delivery is capability-free, so an unmapped client loses nothing today.
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    const result = await client.callTool({ name: 'studio_observe', arguments: {} });
    expect(result.isError).toBeFalsy();
  });

  it('answers the safe default for a connection that has not handshaken', () => {
    const server = createStudioMcpServer({ studioHost: hostHandlers() });
    expect(connectionProfile(server)).toEqual(UNKNOWN_CLIENT_PROFILE);
  });
});

describe('law 5 — adding a harness changes zero behaviour', () => {
  it('returns byte-identical tool results to a mapped and an unmapped harness', async () => {
    // The whole anti-goal in one assertion: if any code path ever branches on the client NAME to
    // decide what to do, these two payloads stop matching.
    const mapped = await connect({ name: 'claude-code', version: '1.2.3' });
    const fabricated = await connect({ name: 'foo-agent', version: '0.3' });

    const call = (c: Client) => c.callTool({ name: 'studio_observe', arguments: { session_id: 'sess-1' } });
    const [a, b] = await Promise.all([call(mapped.client), call(fabricated.client)]);

    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('gives the two harnesses the same capability set and differs only in the phrasing key', async () => {
    const mapped = await connect({ name: 'cursor', version: '2.0' });
    const fabricated = await connect({ name: 'foo-agent', version: '0.3' });
    const mp = connectionProfile(mapped.server);
    const fp = connectionProfile(fabricated.server);

    expect(fp.capabilities).toEqual(mp.capabilities);
    expect(fp.tier).toBe(mp.tier);
    expect(fp.phrasing).not.toBe(mp.phrasing);
  });
});

describe('the ambient seam #56 will consume', () => {
  it('exposes the connection`s profile to the code that phrases its result', async () => {
    seenDuringDispatch = [];
    const { client } = await connect({ name: 'windsurf', version: '3.1' });
    await client.callTool({ name: 'studio_observe', arguments: {} });
    expect(seenDuringDispatch).toHaveLength(1);
    expect(seenDuringDispatch[0]).toEqual({
      tier: 'detected',
      phrasing: 'mcp-tools',
      capabilities: [],
      client: { name: 'windsurf', version: '3.1' },
    });
  });

  it('never hands one connection the profile of another in flight beside it', async () => {
    seenDuringDispatch = [];
    const one = await connect({ name: 'cline', version: '1' });
    const two = await connect({ name: 'foo-agent', version: '1' });
    await Promise.all([
      one.client.callTool({ name: 'studio_observe', arguments: {} }),
      two.client.callTool({ name: 'studio_observe', arguments: {} }),
    ]);
    const byName = new Map(seenDuringDispatch.map((p) => [p.client?.name, p.phrasing]));
    expect(byName.get('cline')).toBe('mcp-tools');
    expect(byName.get('foo-agent')).toBe('generic');
  });
});
