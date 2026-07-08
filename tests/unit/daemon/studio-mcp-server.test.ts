import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createStudioMcpServer } from '../../../src/daemon/studio-mcp-server.js';
import type { StudioHostHandlers } from '../../../src/daemon/studio-dispatch.js';

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

async function connect() {
  spawnCalls = 0;
  const server = createStudioMcpServer({ studioHost: hostHandlers() });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return { client };
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
