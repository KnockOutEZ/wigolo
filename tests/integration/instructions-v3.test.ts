import { describe, it, expect } from 'vitest';
import {
  WIGOLO_INSTRUCTIONS,
  WIGOLO_INSTRUCTIONS_FULL,
  TOOL_DESCRIPTIONS,
} from '../../src/instructions.js';
import type { ToolName } from '../../src/instructions.js';
import { TOOL_SCHEMAS } from '../../src/server/tool-schemas.js';

describe('knowledge layer integration', () => {
  it('WIGOLO_INSTRUCTIONS is usable as MCP server instructions field', () => {
    const instructions: string = WIGOLO_INSTRUCTIONS;
    expect(instructions.length).toBeGreaterThan(0);
    expect(instructions).not.toMatch(/[\x00-\x08\x0B\x0C\x0E-\x1F]/);
  });

  it('all TOOL_DESCRIPTIONS values are valid MCP description strings', () => {
    for (const [name, desc] of Object.entries(TOOL_DESCRIPTIONS)) {
      expect(typeof desc).toBe('string');
      expect(desc.length).toBeGreaterThan(0);
      expect(desc).not.toMatch(/[\x00-\x08\x0B\x0C\x0E-\x1F]/);
      expect(desc).toBe(desc.trim());
    }
  });

  it('every ToolName has a usable description (derived — a hand-written literal had gone stale before)', () => {
    // A hand-written list here can only ever under-report: the loop asserts each NAMED tool has a
    // description, so a tool missing from the list is silently unchecked. Deriving from the source
    // makes the assertion cover the whole union, which is what the title always claimed.
    const allTools = Object.keys(TOOL_DESCRIPTIONS) as ToolName[];
    expect(allTools.length).toBe(10);
    for (const tool of allTools) {
      expect(TOOL_DESCRIPTIONS[tool]).toBeDefined();
      expect(typeof TOOL_DESCRIPTIONS[tool]).toBe('string');
    }
  });

  it('descriptions can be used in a simulated ListTools response', () => {
    const tools = Object.entries(TOOL_DESCRIPTIONS).map(([name, description]) => ({
      name,
      description,
      inputSchema: { type: 'object' as const, properties: {} },
    }));

    expect(tools.length).toBe(10);
    for (const tool of tools) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      const serialized = JSON.stringify(tool);
      expect(serialized).toBeTruthy();
      const parsed = JSON.parse(serialized);
      expect(parsed.description).toBe(tool.description);
    }
  });

  it('WIGOLO_INSTRUCTIONS references every tool in TOOL_DESCRIPTIONS', () => {
    for (const toolName of Object.keys(TOOL_DESCRIPTIONS)) {
      expect(WIGOLO_INSTRUCTIONS).toContain(`\`${toolName}\``);
    }
  });

  it('no tool description exceeds MCP practical limits', () => {
    for (const [name, desc] of Object.entries(TOOL_DESCRIPTIONS)) {
      expect(desc.length).toBeLessThan(2000);
    }
    expect(WIGOLO_INSTRUCTIONS.length).toBeLessThan(10000);
  });

  it('v3 routing table in the full guide covers all intents', () => {
    const intents = [
      'Documentation lookup',
      'Error debugging',
      'Library research',
      'Related content',
      'Direct answer',
      'Comprehensive research',
      'Data gathering',
      'Structured extraction',
      'Site inventory',
    ];
    for (const intent of intents) {
      expect(WIGOLO_INSTRUCTIONS_FULL).toContain(intent);
    }
  });

  it('multi-query guidance section exists in the full guide', () => {
    expect(WIGOLO_INSTRUCTIONS_FULL).toContain('Multi-query');
    expect(WIGOLO_INSTRUCTIONS_FULL).toContain('semantically varied');
    expect(WIGOLO_INSTRUCTIONS_FULL).toContain('keyword forms');
  });
});

/**
 * PIN 8 (#57) at the wire. The description and the schema reach an MCP client as one ListTools
 * entry, so the coherence that matters is not "both files were edited" but "the entry a client
 * actually receives advertises a param the same entry accepts".
 *
 * The pin was written against the two studio descriptions that gained params in #57. Those left
 * core with the surface, so the arm now rides core's own entries — the claim was never specific to
 * those two tools, and stating it on tools core still serves is what keeps it able to fail.
 */
describe('params are coherent in the ListTools entry a client receives', () => {
  const entryFor = (name: ToolName) =>
    JSON.parse(
      JSON.stringify({ name, description: TOOL_DESCRIPTIONS[name], inputSchema: TOOL_SCHEMAS[name] }),
    ) as { description: string; inputSchema: { properties: Record<string, { description?: string }> } };

  it.each([
    ['fetch', ['render_js', 'force_refresh', 'max_content_chars']],
    ['search', ['include_domains', 'force_refresh']],
    ['extract', ['css_selector']],
  ] as const)('%s advertises and accepts the same params', (name, params) => {
    const entry = entryFor(name as ToolName);
    for (const param of params) {
      expect(entry.inputSchema.properties[param], `${name} schema is missing ${param}`).toBeDefined();
      expect(entry.description, `${name} description never names ${param}`).toContain(param);
      expect(entry.inputSchema.properties[param].description, `${param} ships with no description`).toBeTruthy();
    }
  });
});
