/**
 * The `studio_*` MCP surface as an injectable `ToolProvider` — the one place the studio tool set is
 * ENUMERATED, and it enumerates nothing by hand. `tools` is derived from the `studio_`-prefixed keys
 * of `TOOL_SCHEMAS` (already `Record<ToolName, ToolSchema>`, so compile-enforced) and dispatch is
 * derived from the route table in `studio-dispatch.ts` (`Record<StudioToolName, HostRoute>`, likewise).
 * Adding a studio tool is a schema + a description + a route; nothing here changes.
 *
 * What this replaces: ten hand-written `tools/list` literals and a ten-way `name === 'studio_…'`
 * guard in `src/server.ts`, plus a third literal list in the gateway. Both stdio and the gateway now
 * read this provider, so they cannot disagree about what the studio surface is.
 *
 * Import-graph note: this module reaches the session ONLY through `dispatchStudioTool` (proxy or the
 * host-injected closure) — no session-module import, so the stdio path stays untouched.
 */
import { TOOL_DESCRIPTIONS, type ToolName } from '../instructions.js';
import { TOOL_SCHEMAS } from '../server/tool-schemas.js';
import type { ProvidedTool, ToolProvider } from '../server/tool-registry.js';
import { dispatchStudioTool, type StudioHostHandlers, type StudioToolName } from '../daemon/studio-dispatch.js';

export const STUDIO_PROVIDER_NAME = 'studio';

const STUDIO_TOOL_PREFIX = 'studio_';

function isStudioToolName(name: ToolName): name is StudioToolName {
  return name.startsWith(STUDIO_TOOL_PREFIX);
}

/**
 * The advertised studio surface. Order follows `TOOL_SCHEMAS` — the same order the stdio server's
 * hand-written block used, so `tools/list` is byte-identical to before.
 *
 * `studio_fetch` is deliberately absent: it is a broker capability the gateway serves over an
 * already-authenticated transport, never an advertised tool.
 */
export const STUDIO_TOOLS: ReadonlyArray<ProvidedTool> = (Object.keys(TOOL_SCHEMAS) as ToolName[])
  .filter(isStudioToolName)
  .map((name) => ({ name, description: TOOL_DESCRIPTIONS[name], inputSchema: TOOL_SCHEMAS[name] }));

const ADVERTISED = new Set<string>(STUDIO_TOOLS.map((t) => t.name));

export interface StudioToolProviderOptions {
  /**
   * Read LAZILY on every dispatch. `DaemonHttpServer.setStudioHost` is a late setter that fires
   * after the MCP server is built, so capturing the value at construction would strand every
   * already-connected session on the proxy path.
   */
  getHost: () => StudioHostHandlers | undefined;
  /** Resolved per call; the Electron gateway may have none. */
  getDataDir?: () => string | undefined;
}

export function createStudioToolProvider(options: StudioToolProviderOptions): ToolProvider {
  return {
    name: STUDIO_PROVIDER_NAME,
    tools: STUDIO_TOOLS,
    handles: (toolName) => ADVERTISED.has(toolName),
    dispatch: (toolName, args) =>
      dispatchStudioTool(toolName, args, options.getHost(), options.getDataDir?.()),
  };
}
