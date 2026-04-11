import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfig } from '../../../src/config.js';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
  spawn: vi.fn(),
}));

import { execSync } from 'node:child_process';
import { DockerSearxng, isContainerRunning, stopContainer } from '../../../src/searxng/docker.js';

describe('SearXNG Docker', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    resetConfig();
    vi.clearAllMocks();
  });

  afterEach(() => { process.env = originalEnv; resetConfig(); });

  describe('isContainerRunning', () => {
    it('returns true when container is running', () => {
      vi.mocked(execSync).mockReturnValue('true\n' as any);
      expect(isContainerRunning('wigolo-searxng')).toBe(true);
    });

    it('returns false when container is not running', () => {
      vi.mocked(execSync).mockReturnValue('\n' as any);
      expect(isContainerRunning('wigolo-searxng')).toBe(false);
    });

    it('returns false when docker command fails', () => {
      vi.mocked(execSync).mockImplementation(() => { throw new Error(); });
      expect(isContainerRunning('wigolo-searxng')).toBe(false);
    });
  });

  describe('stopContainer', () => {
    it('runs docker stop and rm', () => {
      stopContainer('wigolo-searxng');
      expect(execSync).toHaveBeenCalledWith(
        expect.stringContaining('docker stop wigolo-searxng'),
        expect.anything(),
      );
    });
  });
});
