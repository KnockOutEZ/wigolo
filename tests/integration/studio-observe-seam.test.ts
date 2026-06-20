import { describe, it, expect } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createMcpServer, type Subsystems } from '../../src/server.js';
import type { StudioHostHandlers } from '../../src/daemon/studio-dispatch.js';

/**
 * Proves the WIRING activates the tested seam (not dead code): a real studio_observe
 * call traverses createMcpServer's dispatch arm → dispatchStudioTool → studioHost.observe
 * (execute-on-host), and an UNTRUSTED vision tag survives host-serialize → MCP → client.
 * Pairs with the dispatchStudioTool unit test (verbatim proxy passthrough) to cover the
 * full host→proxy→agent round-trip.
 */
function stubSubsystems(studioHost?: StudioHostHandlers): Subsystems {
  return {
    searchEngines: [],
    router: {},
    backendStatus: {},
    browserPool: {},
    pluginRegistry: {},
    shutdown: async () => {},
    bootstrapSearxng: async () => {},
    studioHost,
  } as unknown as Subsystems;
}

async function callStudioObserve(subsystems: Subsystems, args: Record<string, unknown> = {}) {
  const server = createMcpServer(subsystems);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const res = (await client.callTool({ name: 'studio_observe', arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
    return { res, parsed: JSON.parse(res.content[0].text) as Record<string, unknown> };
  } finally {
    await client.close();
  }
}

describe('studio_observe wiring → seam (createMcpServer dispatch)', () => {
  it('lists studio_observe as an available tool', async () => {
    const server = createMcpServer(stubSubsystems());
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1.0.0' });
    await Promise.all([server.connect(st), client.connect(ct)]);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain('studio_observe');
    await client.close();
  });

  it('on the host (studioHost set) executes via the seam AND preserves trusted:false to the client', async () => {
    let observed = false;
    const studioHost: StudioHostHandlers = {
      observe: async () => {
        observed = true;
        return {
          id: 's1', kind: 'full', trusted: false, elements: [], events: [], eventCursor: 0, eventsDropped: 0, domTruncated: false,
          vision: { region: { x: 0, y: 0, width: 10, height: 10 }, image: { format: 'png', base64: 'AA==' }, trusted: false },
        };
      },
      act: async (input) => ({ ok: true, action: input.action, url: input.url }),
      marks: async () => ({ marks: [] }),
      capture: async () => ({ artifact_id: 1, inserted: true, content_hash: 'h' }),
    };
    const { res, parsed } = await callStudioObserve(stubSubsystems(studioHost));
    expect(observed).toBe(true); // routed through the arm → dispatchStudioTool → studioHost.observe (not dead code)
    expect(res.isError).toBeFalsy();
    expect(parsed.id).toBe('s1');
    expect(parsed.trusted).toBe(false); // the page-perception payload tag survived host → MCP → client
    expect((parsed.vision as { trusted: boolean }).trusted).toBe(false); // untrusted tag survived host → MCP → client
  });

  it('with no studioHost and no handle (stdio, no session) refuses cleanly — no_studio_session', async () => {
    const { res, parsed } = await callStudioObserve(stubSubsystems(undefined));
    expect(res.isError).toBe(true);
    expect(parsed.error_reason).toBe('no_studio_session');
  });
});
