/**
 * P1a — the tool registry that stops core from enumerating Studio.
 *
 * Why this matters: before the registry, `src/server.ts` carried a ten-way `name === 'studio_…'`
 * chain and ten hand-written listTools literals. Miss a name in either and the tool 404s at
 * runtime with a green typecheck — core owning a list it does not own. These tests pin the
 * behaviour the registry has to keep: an advertised surface a provider owns, a dispatch lookup
 * that cannot silently shadow, and a refusal to advertise anything the provider did not list.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ToolRegistry, type ToolProvider } from '../../../src/server/tool-registry.js';
import { TOOL_SCHEMAS } from '../../../src/server/tool-schemas.js';

function fakeProvider(name: string, toolNames: string[], overrides: Partial<ToolProvider> = {}): ToolProvider {
  const listed = new Set(toolNames);
  return {
    name,
    tools: toolNames.map((t) => ({
      name: t as keyof typeof TOOL_SCHEMAS,
      description: `desc for ${t}`,
      inputSchema: TOOL_SCHEMAS.studio_list,
    })),
    handles: (tool: string) => listed.has(tool),
    dispatch: async (tool: string) => ({ content: [{ type: 'text' as const, text: `${name}:${tool}` }], isError: false }),
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ToolRegistry', () => {
  it('advertises every registered provider tool, in registration order', () => {
    const reg = new ToolRegistry();
    reg.register(fakeProvider('a', ['studio_open', 'studio_observe']));
    reg.register(fakeProvider('b', ['studio_list']));
    expect(reg.listTools().map((t) => t.name)).toEqual(['studio_open', 'studio_observe', 'studio_list']);
  });

  it('routes a call to the provider that handles it', async () => {
    const reg = new ToolRegistry();
    reg.register(fakeProvider('a', ['studio_open']));
    reg.register(fakeProvider('b', ['studio_list']));
    const provider = reg.find('studio_list');
    expect(provider?.name).toBe('b');
    const result = await provider!.dispatch('studio_list', {});
    expect(result.content[0].text).toBe('b:studio_list');
  });

  it('returns undefined for an unhandled name so the caller keeps its own unknown-tool refusal', () => {
    const reg = new ToolRegistry();
    reg.register(fakeProvider('a', ['studio_open']));
    expect(reg.find('studio_bogus')).toBeUndefined();
    expect(reg.find('fetch')).toBeUndefined();
  });

  it('ignores a duplicate provider name with a warning rather than throwing (mirrors PluginRegistry)', () => {
    const reg = new ToolRegistry();
    reg.register(fakeProvider('studio', ['studio_open']));
    expect(() => reg.register(fakeProvider('studio', ['studio_list']))).not.toThrow();
    expect(reg.listTools().map((t) => t.name)).toEqual(['studio_open']);
  });

  it('refuses a provider that would shadow an already-advertised tool name — a silent second owner is the bug the registry exists to stop', () => {
    const reg = new ToolRegistry();
    reg.register(fakeProvider('first', ['studio_open']));
    reg.register(fakeProvider('second', ['studio_open', 'studio_list']));
    // The whole provider is rejected, not partially merged: half-registering a surface is worse
    // than refusing it, because dispatch would then disagree with tools/list.
    expect(reg.listTools().map((t) => t.name)).toEqual(['studio_open']);
    expect(reg.find('studio_open')?.name).toBe('first');
    expect(reg.find('studio_list')).toBeUndefined();
  });

  it('reports state for doctor/status output', () => {
    const reg = new ToolRegistry();
    reg.register(fakeProvider('studio', ['studio_open', 'studio_list']));
    expect(reg.getState()).toEqual({
      providers: [{ name: 'studio', tools: ['studio_open', 'studio_list'] }],
      toolCount: 2,
    });
  });

  it('clear() empties the registry so a test can rebuild it', () => {
    const reg = new ToolRegistry();
    reg.register(fakeProvider('studio', ['studio_open']));
    reg.clear();
    expect(reg.listTools()).toEqual([]);
    expect(reg.find('studio_open')).toBeUndefined();
    expect(reg.getState().toolCount).toBe(0);
  });

  it('a provider may handle a name it does not advertise — the unlisted-capability shape studio_fetch relies on', async () => {
    const reg = new ToolRegistry();
    reg.register(
      fakeProvider('a', ['studio_open'], {
        handles: (tool: string) => tool === 'studio_open' || tool === 'studio_fetch',
      }),
    );
    expect(reg.listTools().map((t) => t.name)).toEqual(['studio_open']);
    expect(reg.find('studio_fetch')?.name).toBe('a');
  });
});
