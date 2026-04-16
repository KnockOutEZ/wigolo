import { describe, it, expect } from 'vitest';
import { agentHandlers, getAgentHandler } from '../../../../src/cli/agents/registry.js';

describe('agentHandlers', () => {
  it('contains exactly the 5 expected agents', () => {
    const ids = agentHandlers.map((h) => h.id);
    expect(ids).toContain('claude-code');
    expect(ids).toContain('cursor');
    expect(ids).toContain('vscode');
    expect(ids).toContain('gemini-cli');
    expect(ids).toContain('antigravity');
    expect(ids).toHaveLength(5);
  });

  it('each handler has required fields', () => {
    for (const handler of agentHandlers) {
      expect(typeof handler.id).toBe('string');
      expect(typeof handler.displayName).toBe('string');
      expect(typeof handler.supportsSkills).toBe('boolean');
      expect(typeof handler.supportsCommands).toBe('boolean');
      expect(typeof handler.detect).toBe('function');
      expect(typeof handler.installMcp).toBe('function');
      expect(typeof handler.installInstructions).toBe('function');
      expect(typeof handler.uninstall).toBe('function');
    }
  });

  it('claude-code supports skills and commands', () => {
    const cc = getAgentHandler('claude-code');
    expect(cc?.supportsSkills).toBe(true);
    expect(cc?.supportsCommands).toBe(true);
  });

  it('cursor, vscode, gemini-cli, antigravity do not support skills', () => {
    for (const id of ['cursor', 'vscode', 'gemini-cli', 'antigravity']) {
      expect(getAgentHandler(id)?.supportsSkills).toBe(false);
    }
  });
});

describe('getAgentHandler', () => {
  it('returns handler by id', () => {
    const h = getAgentHandler('claude-code');
    expect(h).toBeDefined();
    expect(h?.id).toBe('claude-code');
  });

  it('returns undefined for unknown id', () => {
    expect(getAgentHandler('unknown-agent')).toBeUndefined();
  });
});
