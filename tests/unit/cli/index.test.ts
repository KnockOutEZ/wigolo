import { describe, it, expect } from 'vitest';
import { parseCommand } from '../../../src/cli/index.js';

describe('parseCommand', () => {
  it('returns "mcp" for no arguments', () => {
    expect(parseCommand([])).toEqual({ command: 'mcp', args: [] });
  });

  it('returns "warmup" for warmup argument', () => {
    expect(parseCommand(['warmup'])).toEqual({ command: 'warmup', args: [] });
  });

  it('returns "serve" for serve argument', () => {
    expect(parseCommand(['serve'])).toEqual({ command: 'serve', args: [] });
  });

  it('returns "serve" with port flag', () => {
    expect(parseCommand(['serve', '--port', '4000'])).toEqual({
      command: 'serve',
      args: ['--port', '4000'],
    });
  });

  it('returns "health" for health argument', () => {
    expect(parseCommand(['health'])).toEqual({ command: 'health', args: [] });
  });

  it('treats unknown commands as mcp mode', () => {
    expect(parseCommand(['unknown'])).toEqual({ command: 'mcp', args: [] });
  });
});
