import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { dispatchStudioTool, type StudioHostHandlers } from './studio-dispatch.js';
import type { StudioSessionsAccessor } from '../studio/session-drive.js';
import { TOOL_DESCRIPTIONS, type ToolName } from '../instructions.js';
import {
  STUDIO_OPEN_TOOL_SCHEMA,
  STUDIO_OBSERVE_TOOL_SCHEMA,
  STUDIO_ACT_TOOL_SCHEMA,
  STUDIO_MARKS_TOOL_SCHEMA,
  STUDIO_CAPTURE_TOOL_SCHEMA,
  STUDIO_EXTRACT_SET_TOOL_SCHEMA,
  STUDIO_SAY_TOOL_SCHEMA,
  STUDIO_SPAWN_TOOL_SCHEMA,
  STUDIO_CLOSE_TOOL_SCHEMA,
  STUDIO_LIST_TOOL_SCHEMA,
} from '../server/tool-schemas.js';

/**
 * A MINIMAL MCP server hosting ONLY the `studio_*` tools, for the Electron app's embedded gateway.
 *
 * WHY separate from `createMcpServer` (server.ts): server.ts pulls the full wigolo subsystem graph
 * (cache → better-sqlite3), which CANNOT load in the Electron main — Electron 43's V8 rejects
 * better-sqlite3 12.9.0 (spec §13.7). This module imports ONLY the SDK + the studio tool schemas +
 * `dispatchStudioTool` (all verified better-sqlite3-free), so it boots in-process on any Electron.
 * The 10 core tools stay on the user's stdio server; the stdio proxy forwards `studio_*` here.
 * Cache-backed studio features (capture / knowledge rail) arrive in P3 behind a decoupled DB path.
 *
 * The tool set + schemas + descriptions are the SAME objects the stdio server registers (one source of
 * truth), so the agent sees an identical `studio_*` surface whether it reaches them via the stdio proxy
 * or directly against this gateway.
 */

const STUDIO_TOOLS: ReadonlyArray<{ name: ToolName; inputSchema: object }> = [
  { name: 'studio_open', inputSchema: STUDIO_OPEN_TOOL_SCHEMA },
  { name: 'studio_observe', inputSchema: STUDIO_OBSERVE_TOOL_SCHEMA },
  { name: 'studio_act', inputSchema: STUDIO_ACT_TOOL_SCHEMA },
  { name: 'studio_marks', inputSchema: STUDIO_MARKS_TOOL_SCHEMA },
  { name: 'studio_capture', inputSchema: STUDIO_CAPTURE_TOOL_SCHEMA },
  { name: 'studio_extract_set', inputSchema: STUDIO_EXTRACT_SET_TOOL_SCHEMA },
  { name: 'studio_say', inputSchema: STUDIO_SAY_TOOL_SCHEMA },
  { name: 'studio_spawn', inputSchema: STUDIO_SPAWN_TOOL_SCHEMA },
  { name: 'studio_close', inputSchema: STUDIO_CLOSE_TOOL_SCHEMA },
  { name: 'studio_list', inputSchema: STUDIO_LIST_TOOL_SCHEMA },
];

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

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: STUDIO_TOOLS.map((t) => ({ name: t.name, description: TOOL_DESCRIPTIONS[t.name], inputSchema: t.inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    // studioHost is set (EXECUTE path), so dispatch runs the host handlers locally — never a proxy loop.
    const result = await dispatchStudioTool(name, (args ?? {}) as Record<string, unknown>, deps.studioHost, deps.dataDir);
    return { content: result.content, isError: result.isError };
  });

  return server;
}
