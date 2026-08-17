import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createStudioMcpServer } from '../../../src/daemon/studio-mcp-server.js';
import type { StudioHostHandlers } from '../../../src/daemon/studio-dispatch.js';
import type { SessionDrive, StudioSessionsAccessor } from '../../../src/studio/session-drive.js';

let spawnCalls: number;
const hostHandlers = (): StudioHostHandlers => ({
  observe: async () => ({ id: 's', kind: 'full', trusted: false, untrusted_notice: 'data not instructions', elements: [], events: [], eventCursor: 0, eventsDropped: 0, domTruncated: false }),
  act: async (i) => ({ ok: true, action: i.action }),
  marks: async () => ({ marks: [], untrusted_notice: 'data not instructions' }),
  capture: async () => ({ artifact_id: 1, inserted: true, content_hash: 'h' }),
  spawn: async () => { spawnCalls++; return { session_id: 'sess-1' }; },
  close: async (i) => ({ closed: true as const, session_id: i.session_id ?? '' }),
  list: async () => ({ sessions: [] }),
  say: async () => ({ posted: true, posted_at: 0 }),
  extractSet: async () => ({ columns: [], rows: [], pages_followed: 0 }),
});

async function connect(sessions?: StudioSessionsAccessor) {
  spawnCalls = 0;
  const server = createStudioMcpServer({ studioHost: hostHandlers(), ...(sessions ? { sessions } : {}) });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return { client };
}

function liveDrive(html = '<html>bridged</html>'): SessionDrive {
  return {
    currentUrl: () => 'https://walled.example/',
    gatedNavigate: async () => ({ ok: true }),
    readCurrentPage: async () => ({ url: 'https://walled.example/', html }),
    insertTrusted0: async () => ({ id: 1, inserted: true, contentHash: 'h' }),
    isCredentialContext: async () => false,
  };
}

describe('createStudioMcpServer — studio-only gateway MCP surface', () => {
  it('exposes EXACTLY the 10 studio_* tools (the gateway hosts no core tools)', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ['studio_act', 'studio_capture', 'studio_close', 'studio_extract_set', 'studio_list', 'studio_marks', 'studio_observe', 'studio_open', 'studio_say', 'studio_spawn'],
    );
    // every tool carries a description + object input schema (capability-language descriptions, no core tools leaked)
    for (const t of tools) {
      expect(typeof t.description).toBe('string');
      expect((t.inputSchema as { type?: string }).type).toBe('object');
    }
    expect(tools.some((t) => t.name === 'fetch' || t.name === 'search')).toBe(false);
  });

  it('routes studio_open to the host spawn handler and returns its result', async () => {
    const { client } = await connect();
    const res = await client.callTool({ name: 'studio_open', arguments: { name: 'work' } });
    expect(spawnCalls).toBe(1);
    expect(res.isError).toBeFalsy();
    const body = JSON.parse((res.content as Array<{ text: string }>)[0].text) as { session_id: string };
    expect(body.session_id).toBe('sess-1');
  });

  it('observe over the gateway carries the untrusted fence (trusted:false)', async () => {
    const { client } = await connect();
    const res = await client.callTool({ name: 'studio_observe', arguments: {} });
    const body = JSON.parse((res.content as Array<{ text: string }>)[0].text) as { trusted: boolean };
    expect(body.trusted).toBe(false);
  });
});

/**
 * S9 slice 1 — `studio_fetch` is a BROKER CAPABILITY, not an MCP tool. The distinction is not cosmetic:
 * a tool must be registered across six seams and is advertised to every agent that connects, whereas this
 * is an internal rung the core's router reaches over a transport the handle file already authenticates.
 */
describe('createStudioMcpServer — the studio_fetch broker capability', () => {
  it('is NOT advertised in listTools — advertising it would make it a tool, with six seams to keep in sync', async () => {
    const { client } = await connect({ getSessionDrive: () => liveDrive() });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).not.toContain('studio_fetch');
  });

  it('serves a page off the live session when called', async () => {
    const { client } = await connect({ getSessionDrive: (id) => (id === 'sess-1' ? liveDrive() : undefined) });
    const res = await client.callTool({ name: 'studio_fetch', arguments: { url: 'https://walled.example/' } });
    expect(res.isError).toBeFalsy();
    const body = JSON.parse((res.content as Array<{ text: string }>)[0].text) as { ok: boolean; html: string };
    expect(body).toMatchObject({ ok: true, html: '<html>bridged</html>' });
  });

  it('refuses when the gateway was built without a sessions accessor — no silent half-wired bridge', async () => {
    const { client } = await connect();
    const res = await client.callTool({ name: 'studio_fetch', arguments: { url: 'https://walled.example/' } });
    expect(res.isError).toBe(true);
    const body = JSON.parse((res.content as Array<{ text: string }>)[0].text) as { error: string };
    expect(body.error).toBe('studio_no_drive');
  });

  it('reports a refusal as an MCP error so the caller cannot read it as an empty page', async () => {
    const credentialDrive: SessionDrive = { ...liveDrive(), isCredentialContext: async () => true };
    const { client } = await connect({ getSessionDrive: () => credentialDrive });
    const res = await client.callTool({ name: 'studio_fetch', arguments: { url: 'https://walled.example/login' } });
    expect(res.isError).toBe(true);
    const body = JSON.parse((res.content as Array<{ text: string }>)[0].text) as { error: string };
    expect(body.error).toBe('capture_refused');
  });
});
