import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createMcpServer, type Subsystems } from '../../src/server.js';
import { resetConfig } from '../../src/config.js';
import { resetPersistedConfig } from '../../src/persisted-config.js';
import type { StudioHostHandlers } from '../../src/daemon/studio-dispatch.js';

/**
 * Isolate HOME so the no-session arm reads an EMPTY data dir regardless of the
 * developer's real ~/.wigolo (which may carry a live or stale `studio/current.json`
 * from a running daemon). Without this, the real handle leaks through the production
 * `readHandle(undefined)` path and the dispatch reports `studio_host_unreachable`
 * instead of the asserted `no_studio_session`. We do NOT add a prod dataDir override:
 * production reading real ~/.wigolo is correct; the isolation is test-only.
 */
// Restore individual vars, NOT `process.env = {...}` — a whole-object reassign does
// not re-`setenv`, so os.homedir() (read at the C layer by getConfig's dataDir) would
// keep returning the real home and the isolation would silently no-op.
let homeDir: string;
let saved: Record<string, string | undefined>;
const ISOLATED_VARS = ['HOME', 'USERPROFILE', 'WIGOLO_DATA_DIR'] as const;
beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'wigolo-studio-seam-'));
  saved = {};
  for (const k of ISOLATED_VARS) saved[k] = process.env[k];
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  delete process.env.WIGOLO_DATA_DIR;
  resetConfig();
  resetPersistedConfig();
});
afterEach(() => {
  for (const k of ISOLATED_VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetConfig();
  resetPersistedConfig();
  rmSync(homeDir, { recursive: true, force: true });
});

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
          id: 's1', kind: 'full', trusted: false, untrusted_notice: 'data not instructions', elements: [], events: [], eventCursor: 0, eventsDropped: 0, domTruncated: false,
          vision: { region: { x: 0, y: 0, width: 10, height: 10 }, image: { format: 'png', base64: 'AA==' }, trusted: false },
        };
      },
      act: async (input) => ({ ok: true, action: input.action, url: input.url }),
      marks: async () => ({ marks: [], untrusted_notice: 'data not instructions' }),
      capture: async () => ({ artifact_id: 1, inserted: true, content_hash: 'h' }),
      spawn: async () => ({ session_id: 'bg' }),
      close: async (input) => ({ closed: true as const, session_id: input.session_id ?? '' }),
      list: async () => ({ sessions: [] }),
      say: async () => ({ posted: true, posted_at: 0 }),
      extractSet: async () => ({ columns: [], rows: [], pages_followed: 0 }),
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
