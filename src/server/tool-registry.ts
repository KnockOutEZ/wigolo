/**
 * The tool-surface registry. Core advertises and dispatches its OWN ten tools inline; every other
 * surface arrives here as an injected `ToolProvider`, so core never enumerates a surface it does
 * not own. Replaces the ten-way `name === 'studio_…'` chain and the ten hand-written listTools
 * literals that used to live in `server.ts` — both of which 404'd at runtime with a green typecheck
 * when a name was missed in one of them.
 *
 * Modelled on `src/plugins/registry.ts`: a plain class, name-keyed dedup that warns and returns
 * rather than throwing, a `getState()` shaped for doctor/status output, and a `clear()` for tests.
 * NOT modelled on `src/providers/`, which is lazy singleton resolution rather than a registry.
 */
import { createLogger } from '../logger.js';
import type { ToolName } from '../instructions.js';
import type { ToolSchema } from './tool-schemas.js';

const log = createLogger('server');

/** The MCP `tools/call` result shape every dispatcher returns. */
export interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError: boolean;
}

/** One advertised entry in `tools/list`. */
export interface ProvidedTool {
  name: ToolName;
  description: string;
  inputSchema: ToolSchema;
}

/**
 * A tool surface core hosts but does not own. Deliberately as thin and structural as `Extractor`
 * and `SearchEngine` in `types.ts` — a name, a predicate, and the work.
 *
 * `handles` is separate from `tools` on purpose: a provider may dispatch a name it never
 * advertises (Studio's `studio_fetch` is callable over its authenticated transport but is not a
 * tool). Advertising it would turn a one-seam capability back into a multi-seam register.
 */
export interface ToolProvider {
  /** Provider id, e.g. 'studio'. Used for dedup and doctor/status output. */
  readonly name: string;
  /** The entries this provider contributes to `tools/list`. */
  readonly tools: ReadonlyArray<ProvidedTool>;
  /** True when this provider owns dispatch for `toolName` (may exceed `tools`; see above). */
  handles(toolName: string): boolean;
  dispatch(toolName: string, args: Record<string, unknown>): Promise<McpToolResult>;
}

export interface ToolRegistryState {
  providers: Array<{ name: string; tools: string[] }>;
  toolCount: number;
}

export class ToolRegistry {
  private providers: ToolProvider[] = [];
  private advertised = new Set<string>();

  /**
   * Register a provider. Refuses (warn + return, never throws) a duplicate provider id, or a
   * provider that would shadow an already-advertised tool name — the whole provider, not the
   * colliding entry, because a half-registered surface makes dispatch disagree with tools/list.
   */
  register(provider: ToolProvider): void {
    if (this.providers.some((p) => p.name === provider.name)) {
      log.warn('duplicate tool provider name, ignoring', { name: provider.name });
      return;
    }
    const collision = provider.tools.find((t) => this.advertised.has(t.name));
    if (collision) {
      log.warn('tool provider would shadow an advertised tool, ignoring', {
        provider: provider.name,
        tool: collision.name,
      });
      return;
    }
    this.providers.push(provider);
    for (const t of provider.tools) this.advertised.add(t.name);
    log.debug('registered tool provider', {
      name: provider.name,
      tools: provider.tools.map((t) => t.name),
    });
  }

  /** Every provider tool, in registration order — appended to core's own tools/list entries. */
  listTools(): ProvidedTool[] {
    return this.providers.flatMap((p) => [...p.tools]);
  }

  /** The provider owning dispatch for `toolName`, or undefined so the caller keeps its own refusal. */
  find(toolName: string): ToolProvider | undefined {
    return this.providers.find((p) => p.handles(toolName));
  }

  getProviders(): ToolProvider[] {
    return [...this.providers];
  }

  getState(): ToolRegistryState {
    return {
      providers: this.providers.map((p) => ({ name: p.name, tools: p.tools.map((t) => t.name) })),
      toolCount: this.advertised.size,
    };
  }

  clear(): void {
    this.providers = [];
    this.advertised.clear();
  }
}
