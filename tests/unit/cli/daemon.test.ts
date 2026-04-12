import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runDaemon } from '../../../src/cli/daemon.js';

describe('runDaemon', () => {
  beforeEach(() => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  it('prints v2 message to stderr', () => {
    runDaemon([]);
    expect(process.stderr.write).toHaveBeenCalledWith(
      expect.stringContaining('Coming in v2'),
    );
  });

  it('prints v2 message with port flag', () => {
    runDaemon(['--port', '4000']);
    expect(process.stderr.write).toHaveBeenCalledWith(
      expect.stringContaining('Coming in v2'),
    );
  });
});
