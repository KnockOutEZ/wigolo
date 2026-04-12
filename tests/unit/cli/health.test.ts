import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runHealthCheck } from '../../../src/cli/health.js';

describe('runHealthCheck', () => {
  beforeEach(() => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  it('prints v2 message to stderr', () => {
    runHealthCheck();
    expect(process.stderr.write).toHaveBeenCalledWith(
      expect.stringContaining('Coming in v2'),
    );
  });
});
