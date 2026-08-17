import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { StudioHostHandlers } from './studio-dispatch.js';
import { runStudioFetch, STUDIO_FETCH_CAPABILITY, type StudioFetchInput } from '../studio/studio-fetch.js';
import type { StudioSessionsAccessor } from '../studio/session-drive.js';
import { createStudioToolProvider } from '../studio/tool-provider.js';

/**
 * A MINIMAL MCP server hosting ONLY the `studio_*` tools, for the Electron app's embedded gateway.
 *
 * WHY separate from `createMcpServer` (server.ts): server.ts pulls the full wigolo subsystem graph
 * (cache → better-sqlite3), and this module imports ONLY the SDK + the studio tool schemas +
 * `dispatchStudioTool`, so it boots in-process without that graph. The 10 core tools stay on the
 * user's stdio server; the stdio proxy forwards `studio_*` here. Cache-backed studio features
 * (capture / knowledge rail) go through the decoupled DB path.
 *
 * ⚠ THE ORIGINAL REASON NO LONGER HOLDS, and is corrected here rather than left to mislead. This
 * said the graph "CANNOT load in the Electron main — Electron 43's V8 rejects better-sqlite3
 * 12.9.0 (spec §13.7)". That was true of the 12.9.0 pin, which is V8-ABI-bound and fails with
 * NODE_MODULE_VERSION 127 vs 148. The pin is now 13.0.3, whose Node-API prebuilds load in a real
 * Electron 43 main — measured, in both the main and renderer processes, with FTS5 and the vector
 * extension working and no rebuild step. So the ABI wall is gone and the separation now rests on
 * what it costs to boot, not on what can be loaded. Keeping a falsified cause in a comment is how
 * the next reader spends a day proving something that is already known.
 *
 * The tool set + schemas + descriptions come from the SAME ToolProvider the stdio server registers
 * (one source of truth, derived from the tool schemas — no third literal list), so the agent sees an
 * identical `studio_*` surface whether it reaches them via the stdio proxy or directly against this
 * gateway.
 */

export interface StudioMcpServerDeps {
  studioHost: StudioHostHandlers;
  sessions?: StudioSessionsAccessor;
  dataDir?: string;
}

/** Build a fresh MCP Server (one per transport session) that dispatches the studio_* surface to the host. */
export function createStudioMcpServer(deps: StudioMcpServerDeps): Server {
  const server = new Server(
    { name: 'wigolo-studio', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  // This gateway IS the host, so the provider's host is always set — dispatch executes locally and
  // never enters the proxy path.
  const provider = createStudioToolProvider({
    getHost: () => deps.studioHost,
    getDataDir: () => deps.dataDir,
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...provider.tools] }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    // S9 — the broker `studio_fetch` capability. Handled HERE and only here: the provider neither
    // advertises nor handles it, so it is callable over this already-authenticated transport but is
    // never advertised as a tool (which would make it the six-seam register instead of one seam).
    if (name === STUDIO_FETCH_CAPABILITY) {
      const body = deps.sessions
        ? await runStudioFetch({ sessions: deps.sessions, host: deps.studioHost }, (args ?? {}) as unknown as StudioFetchInput)
        : ({ ok: false, error: 'studio_no_drive', error_reason: 'This studio gateway was started without a session accessor.' } as const);
      return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], isError: !body.ok };
    }
    const result = await provider.dispatch(name, (args ?? {}) as Record<string, unknown>);
    return { content: result.content, isError: result.isError };
  });

  return server;
}
