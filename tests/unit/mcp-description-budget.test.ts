import { describe, it, expect } from 'vitest';
import { encode } from 'gpt-tokenizer';
import { TOOL_SCHEMAS } from '../../src/server/tool-schemas.js';
import { TOOL_DESCRIPTIONS, type ToolName } from '../../src/instructions.js';

export const TOOL_DESC_BUDGET = 400;
export const ARG_DESC_BUDGET = 80;

interface ArgEntry { tool: ToolName; path: string; tokens: number; }

function walkArgs(node: unknown, tool: ToolName, prefix: string, out: ArgEntry[]): void {
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  if (typeof obj.description === 'string' && obj.description.length > 0) {
    out.push({ tool, path: prefix || '(root)', tokens: encode(obj.description).length });
  }
  // Recurse into object schemas
  const props = obj.properties as Record<string, unknown> | undefined;
  if (props) {
    for (const [k, v] of Object.entries(props)) walkArgs(v, tool, `${prefix}${prefix ? '.' : ''}${k}`, out);
  }
  // Recurse into array schemas
  if (obj.items) walkArgs(obj.items, tool, `${prefix}[]`, out);
  // Recurse into union schemas
  for (const key of ['oneOf', 'anyOf', 'allOf']) {
    const arr = obj[key];
    if (Array.isArray(arr)) arr.forEach((v, i) => walkArgs(v, tool, `${prefix}.${key}[${i}]`, out));
  }
}

describe('MCP description token budgets', () => {
  const toolEntries = (Object.keys(TOOL_DESCRIPTIONS) as ToolName[]).map((name) => ({
    name,
    tokens: encode(TOOL_DESCRIPTIONS[name]).length,
  }));
  const argEntries: ArgEntry[] = [];
  for (const name of Object.keys(TOOL_SCHEMAS) as ToolName[]) walkArgs(TOOL_SCHEMAS[name], name, '', argEntries);

  it('reports per-tool description tokens (informational)', () => {
    // eslint-disable-next-line no-console
    console.log('\nPer-tool description tokens:');
    for (const t of toolEntries) {
      const headroom = TOOL_DESC_BUDGET - t.tokens;
      // eslint-disable-next-line no-console
      console.log(`  ${t.name.padEnd(14)} ${String(t.tokens).padStart(4)} / ${TOOL_DESC_BUDGET}  (headroom ${headroom})`);
    }
    // eslint-disable-next-line no-console
    console.log('\nArg description top-10 tokens:');
    [...argEntries]
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 10)
      .forEach((a) => {
        // eslint-disable-next-line no-console
        console.log(`  ${a.tool}.${a.path}  ${a.tokens} / ${ARG_DESC_BUDGET}`);
      });
    expect(toolEntries.length).toBe(8);
    expect(argEntries.length).toBeGreaterThan(0); // sanity: walker actually walked
  });

  describe.each(toolEntries)('tool $name', ({ name, tokens }) => {
    it(`description \u2264 ${TOOL_DESC_BUDGET} tokens (current: ${tokens})`, () => {
      expect(
        tokens,
        `tool '${name}' description is ${tokens} tokens (budget ${TOOL_DESC_BUDGET})`,
      ).toBeLessThanOrEqual(TOOL_DESC_BUDGET);
    });
  });

  it(`every arg description \u2264 ${ARG_DESC_BUDGET} tokens`, () => {
    const offenders = argEntries.filter((a) => a.tokens > ARG_DESC_BUDGET);
    expect(
      offenders,
      `over-budget arg descriptions:\n${offenders
        .map((a) => `  ${a.tool}.${a.path}: ${a.tokens} > ${ARG_DESC_BUDGET}`)
        .join('\n')}`,
    ).toEqual([]);
  });
});
