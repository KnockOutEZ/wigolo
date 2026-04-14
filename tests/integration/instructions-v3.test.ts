import { describe, it, expect } from 'vitest';
import { WIGOLO_INSTRUCTIONS, TOOL_DESCRIPTIONS } from '../../src/instructions.js';
import type { ToolName } from '../../src/instructions.js';

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

  it('ToolName type includes all 8 v3 tools', () => {
    const allTools: ToolName[] = [
      'fetch', 'search', 'crawl', 'cache', 'extract',
      'find_similar', 'research', 'agent',
    ];
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

    expect(tools.length).toBe(8);
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

  it('v3 routing table in instructions covers all intents', () => {
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
      expect(WIGOLO_INSTRUCTIONS).toContain(intent);
    }
  });

  it('multi-query guidance section exists in instructions', () => {
    expect(WIGOLO_INSTRUCTIONS).toContain('Multi-query');
    expect(WIGOLO_INSTRUCTIONS).toContain('semantically varied');
    expect(WIGOLO_INSTRUCTIONS).toContain('keyword forms');
  });
});
