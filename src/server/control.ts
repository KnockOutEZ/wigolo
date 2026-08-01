import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  TOOL_DESCRIPTIONS,
  WIGOLO_DOCS_URI,
  WIGOLO_INSTRUCTIONS,
  WIGOLO_INSTRUCTIONS_FULL,
} from '../instructions.js';
import { TOOL_SCHEMAS } from './tool-schemas.js';

export const MCP_TOOL_ORDER = [
  'fetch',
  'search',
  'crawl',
  'cache',
  'extract',
  'find_similar',
  'research',
  'agent',
  'diff',
  'watch',
] as const;

export const MCP_TOOL_DEFINITIONS = MCP_TOOL_ORDER.map((name) => ({
  name,
  description: TOOL_DESCRIPTIONS[name],
  inputSchema: TOOL_SCHEMAS[name],
}));

function readPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

type RuntimeModule = typeof import('../server.js');
type Runtime = { module: RuntimeModule; subsystems: import('../server.js').Subsystems };
export type RuntimeSource = Runtime['subsystems'] | (() => Promise<Runtime['subsystems']>);

export function createMcpServer(
  source: RuntimeSource,
): { server: Server; shutdownRuntime: () => Promise<void> } {
  let runtimeReady: Promise<Runtime> | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let initializationFailureLogged = false;
  let initializationRollbackFailed = false;
  const ownsRuntime = typeof source === 'function';

  const getRuntime = (): Promise<Runtime> => {
    if (!runtimeReady) {
      runtimeReady = (async () => {
        const runtime = await import('../server.js');
        try {
          const subsystems = typeof source === 'function' ? await source() : source;
          if (ownsRuntime) runtime.startRuntimeBackgroundWork(subsystems);
          return { module: runtime, subsystems };
        } catch (err) {
          // Initialization failure is sticky. initSubsystems owns rollback;
          // the control plane only records the failure and never retries.
          if (!initializationFailureLogged) {
            initializationFailureLogged = true;
            process.stderr.write(`[wigolo] runtime initialization failed: ${String(err)}\n`);
          }
          initializationRollbackFailed = err instanceof AggregateError
            && err.message === 'runtime initialization and rollback failed';
          throw err;
        }
      })();
    }
    return runtimeReady;
  };

  const server = new Server(
    { name: 'wigolo', version: readPackageVersion() },
    { capabilities: { tools: {}, resources: {} }, instructions: WIGOLO_INSTRUCTIONS },
  );

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [{
      uri: WIGOLO_DOCS_URI,
      name: 'Wigolo usage guide',
      description: 'Routing tables, performance budgets, auth flows, and other detail trimmed from the per-session instructions.',
      mimeType: 'text/markdown',
    }],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (request.params.uri !== WIGOLO_DOCS_URI) {
      throw new Error(`Unknown resource: ${request.params.uri}`);
    }
    return {
      contents: [{ uri: WIGOLO_DOCS_URI, mimeType: 'text/markdown', text: WIGOLO_INSTRUCTIONS_FULL }],
    };
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: MCP_TOOL_DEFINITIONS }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    if (!MCP_TOOL_ORDER.includes(request.params.name as (typeof MCP_TOOL_ORDER)[number])) {
      return { content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }], isError: true };
    }

    let runtime: Runtime;
    try {
      runtime = await getRuntime();
    } catch {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: 'Wigolo runtime initialization failed',
            error_reason: 'runtime_initialization_failed',
            stage: 'runtime_init',
            retryable: false,
          }, null, 2),
        }],
        isError: true,
      };
    }

    return runtime.module.dispatchTool(runtime.subsystems, server, request, extra);
  });

  const shutdownRuntime = (): Promise<void> => {
    if (!shutdownPromise) {
      shutdownPromise = (async () => {
        if (!ownsRuntime || !runtimeReady) return;
        let runtime: Runtime;
        try {
          runtime = await runtimeReady;
        } catch (err) {
          // Initialization failure was already logged and cleaned up.
          if (initializationRollbackFailed) throw err;
          return;
        }
        try {
          await runtime.subsystems.shutdown();
        } catch (err) {
          process.stderr.write(`[wigolo] runtime shutdown failed: ${String(err)}\n`);
          throw err;
        }
      })();
    }
    return shutdownPromise;
  };

  return { server, shutdownRuntime };
}

export function createLazyMcpServer(): { server: Server; shutdownRuntime: () => Promise<void> } {
  return createMcpServer(async () => {
    const runtime = await import('../server.js');
    return runtime.initSubsystems();
  });
}

export async function startStdioServer(): Promise<void> {
  const { server, shutdownRuntime } = createLazyMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('[wigolo] MCP server started\n');

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    if (!shutdownPromise) {
      shutdownPromise = (async () => {
        let serverCloseError: unknown;
        try {
          await server.close();
        } catch (err) {
          serverCloseError = err;
          process.stderr.write(`[wigolo] MCP server shutdown failed: ${String(err)}\n`);
        }
        try {
          await shutdownRuntime();
          if (serverCloseError) throw serverCloseError;
          process.exit(0);
        } catch {
          process.exit(1);
        }
      })();
    }
    return shutdownPromise;
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}
