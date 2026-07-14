import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfig } from '../../../src/config.js';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));

import { execSync, execFileSync } from 'node:child_process';
import {
  DockerSearxng,
  isContainerRunning,
  stopContainer,
  resolveContainerCli,
  __resetResolvedContainerCli,
} from '../../../src/searxng/docker.js';

describe('SearXNG Docker', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    resetConfig();
    vi.clearAllMocks();
    __resetResolvedContainerCli();
  });

  afterEach(() => { process.env = originalEnv; resetConfig(); __resetResolvedContainerCli(); });

  describe('resolveContainerCli', () => {
    it('prefers docker when both docker and podman are available', () => {
      vi.mocked(execSync).mockReturnValue('Docker version 24.0.0' as any);
      expect(resolveContainerCli()).toBe('docker');
      expect(execSync).toHaveBeenCalledTimes(1);
      expect(execSync).toHaveBeenCalledWith('docker --version', expect.anything());
    });

    it('falls back to podman when docker is not found', () => {
      vi.mocked(execSync).mockImplementation((cmd) => {
        if (String(cmd).startsWith('docker')) throw new Error('docker: command not found');
        return 'podman version 4.9.0' as any;
      });
      expect(resolveContainerCli()).toBe('podman');
      expect(execSync).toHaveBeenCalledWith('docker --version', expect.anything());
      expect(execSync).toHaveBeenCalledWith('podman --version', expect.anything());
    });

    it('returns null when neither docker nor podman is found', () => {
      vi.mocked(execSync).mockImplementation(() => { throw new Error('command not found'); });
      expect(resolveContainerCli()).toBeNull();
    });

    it('memoizes the resolved CLI — only probes once across repeated calls', () => {
      vi.mocked(execSync).mockReturnValue('Docker version 24.0.0' as any);
      expect(resolveContainerCli()).toBe('docker');
      expect(resolveContainerCli()).toBe('docker');
      expect(resolveContainerCli()).toBe('docker');
      expect(execSync).toHaveBeenCalledTimes(1);
    });

    it('re-probes after __resetResolvedContainerCli', () => {
      vi.mocked(execSync).mockReturnValue('Docker version 24.0.0' as any);
      expect(resolveContainerCli()).toBe('docker');
      __resetResolvedContainerCli();
      vi.mocked(execSync).mockImplementation(() => { throw new Error('gone'); });
      expect(resolveContainerCli()).toBeNull();
    });
  });

  describe('isContainerRunning', () => {
    it('returns true when container is running (docker)', () => {
      vi.mocked(execSync).mockReturnValue('Docker version 24.0.0' as any);
      vi.mocked(execFileSync).mockReturnValue('true\n' as any);
      expect(isContainerRunning('wigolo-searxng')).toBe(true);
      expect(execFileSync).toHaveBeenCalledWith(
        'docker',
        ['inspect', '--format', '{{.State.Running}}', '--', 'wigolo-searxng'],
        expect.anything(),
      );
    });

    it('returns true when container is running via podman fallback', () => {
      vi.mocked(execSync).mockImplementation((cmd) => {
        if (String(cmd).startsWith('docker')) throw new Error('docker: command not found');
        return 'podman version 4.9.0' as any;
      });
      vi.mocked(execFileSync).mockReturnValue('true\n' as any);
      expect(isContainerRunning('wigolo-searxng')).toBe(true);
      expect(execFileSync).toHaveBeenCalledWith(
        'podman',
        ['inspect', '--format', '{{.State.Running}}', '--', 'wigolo-searxng'],
        expect.anything(),
      );
    });

    it('returns false when container is not running', () => {
      vi.mocked(execSync).mockReturnValue('Docker version 24.0.0' as any);
      vi.mocked(execFileSync).mockReturnValue('\n' as any);
      expect(isContainerRunning('wigolo-searxng')).toBe(false);
    });

    it('returns false when the docker command fails', () => {
      vi.mocked(execSync).mockReturnValue('Docker version 24.0.0' as any);
      vi.mocked(execFileSync).mockImplementation(() => { throw new Error(); });
      expect(isContainerRunning('wigolo-searxng')).toBe(false);
    });

    it('returns false when no docker-compatible CLI is found at all', () => {
      vi.mocked(execSync).mockImplementation(() => { throw new Error('not found'); });
      expect(isContainerRunning('wigolo-searxng')).toBe(false);
      // no inspect attempt should have been made — resolution failed first
      expect(execFileSync).not.toHaveBeenCalled();
    });

    it('passes the container name as a literal argument, not shell-interpolated', () => {
      vi.mocked(execSync).mockReturnValue('Docker version 24.0.0' as any);
      vi.mocked(execFileSync).mockReturnValue('true\n' as any);
      const trickyName = "wigolo; rm -rf / #'";
      isContainerRunning(trickyName);
      expect(execFileSync).toHaveBeenCalledWith(
        'docker',
        ['inspect', '--format', '{{.State.Running}}', '--', trickyName],
        expect.anything(),
      );
    });
  });

  describe('stopContainer', () => {
    it('runs docker stop then rm when docker is available', () => {
      vi.mocked(execSync).mockReturnValue('Docker version 24.0.0' as any);
      stopContainer('wigolo-searxng');
      expect(execFileSync).toHaveBeenCalledWith('docker', ['stop', '--', 'wigolo-searxng'], expect.anything());
      expect(execFileSync).toHaveBeenCalledWith('docker', ['rm', '--', 'wigolo-searxng'], expect.anything());
    });

    it('runs podman stop then rm when only podman is available', () => {
      vi.mocked(execSync).mockImplementation((cmd) => {
        if (String(cmd).startsWith('docker')) throw new Error('docker: command not found');
        return 'podman version 4.9.0' as any;
      });
      stopContainer('wigolo-searxng');
      expect(execFileSync).toHaveBeenCalledWith('podman', ['stop', '--', 'wigolo-searxng'], expect.anything());
      expect(execFileSync).toHaveBeenCalledWith('podman', ['rm', '--', 'wigolo-searxng'], expect.anything());
    });

    it('does nothing when no docker-compatible CLI is found', () => {
      vi.mocked(execSync).mockImplementation(() => { throw new Error('not found'); });
      stopContainer('wigolo-searxng');
      expect(execFileSync).not.toHaveBeenCalled();
    });
  });

  describe('DockerSearxng.start', () => {
    const originalFetch = global.fetch;
    afterEach(() => { global.fetch = originalFetch; });

    it('returns null immediately when no docker-compatible CLI is found', async () => {
      vi.mocked(execSync).mockImplementation(() => { throw new Error('not found'); });
      const instance = new DockerSearxng();
      const url = await instance.start();
      expect(url).toBeNull();
      expect(execSync).not.toHaveBeenCalledWith(expect.stringContaining('run -d'), expect.anything());
    });

    it('runs the container via podman when docker is unavailable and reports healthy', async () => {
      vi.mocked(execSync).mockImplementation((cmd) => {
        const s = String(cmd);
        if (s.startsWith('docker')) throw new Error('docker: command not found');
        return 'podman version 4.9.0' as any;
      });
      global.fetch = vi.fn().mockResolvedValue({ ok: true }) as any;

      const instance = new DockerSearxng();
      const url = await instance.start();

      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(execFileSync).toHaveBeenCalledWith(
        'podman',
        expect.arrayContaining(['run', '-d', '--name', 'wigolo-searxng']),
        expect.anything(),
      );
    });
  });
});
