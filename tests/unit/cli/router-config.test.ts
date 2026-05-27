/**
 * Tests that `config` and `dashboard` commands are routed correctly and
 * that neither is routed to 'mcp' (the MCP stdio path).
 */
import { describe, expect, it } from 'vitest';
import { parseCommand } from '../../../src/cli/index.js';

describe('parseCommand — config/dashboard routing', () => {
  it('routes "config" to config command', () => {
    const { command } = parseCommand(['config']);
    expect(command).toBe('config');
  });

  it('routes "dashboard" to dashboard command', () => {
    const { command } = parseCommand(['dashboard']);
    expect(command).toBe('dashboard');
  });

  it('routes "config" with flags correctly', () => {
    const { command, args } = parseCommand(['config', '--plain']);
    expect(command).toBe('config');
    expect(args).toContain('--plain');
  });

  it('no args routes to mcp (stdio protocol), NOT to config or init', () => {
    const { command } = parseCommand([]);
    expect(command).toBe('mcp');
  });

  it('mcp command is distinct from config command', () => {
    const mcpResult = parseCommand(['mcp']);
    const configResult = parseCommand(['config']);
    expect(mcpResult.command).toBe('mcp');
    expect(configResult.command).toBe('config');
    expect(mcpResult.command).not.toBe(configResult.command);
  });
});
