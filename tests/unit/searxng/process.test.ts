import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfig } from '../../../src/config.js';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  execSync: vi.fn(),
}));

vi.mock('node:net', () => ({
  createServer: vi.fn(),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

import { findAvailablePort, acquireLock, releaseLock, SearxngProcess } from '../../../src/searxng/process.js';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';

describe('SearXNG process management', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    resetConfig();
    vi.clearAllMocks();
  });

  afterEach(() => { process.env = originalEnv; resetConfig(); });

  describe('findAvailablePort', () => {
    it('returns configured port when available', async () => {
      const mockServer = {
        listen: vi.fn((_port: number, cb: () => void) => { cb(); return mockServer; }),
        close: vi.fn((cb: () => void) => { cb(); }),
        address: vi.fn().mockReturnValue({ port: 8888 }),
        on: vi.fn().mockReturnThis(),
      };
      vi.mocked(createServer).mockReturnValue(mockServer as any);

      const port = await findAvailablePort(8888);
      expect(port).toBe(8888);
    });

    it('tries next port when configured port is occupied', async () => {
      let callCount = 0;
      const mockServer = {
        listen: vi.fn((_port: number, cb: () => void) => {
          callCount++;
          if (callCount === 1) {
            setTimeout(() => mockServer._errorHandler?.(new Error('EADDRINUSE')), 0);
          } else {
            cb();
          }
          return mockServer;
        }),
        close: vi.fn((cb: () => void) => { cb(); }),
        address: vi.fn().mockReturnValue({ port: 8889 }),
        on: vi.fn((event: string, handler: any) => {
          if (event === 'error') mockServer._errorHandler = handler;
          return mockServer;
        }),
        _errorHandler: null as any,
      };
      vi.mocked(createServer).mockReturnValue(mockServer as any);

      const port = await findAvailablePort(8888);
      expect(port).toBe(8889);
    });

    it('rejects when no port is available in range', async () => {
      const mockServer = {
        listen: vi.fn((_port: number, _cb: () => void) => {
          setTimeout(() => mockServer._errorHandler?.(new Error('EADDRINUSE')), 0);
          return mockServer;
        }),
        close: vi.fn((cb: () => void) => { cb(); }),
        address: vi.fn().mockReturnValue(null),
        on: vi.fn((event: string, handler: any) => {
          if (event === 'error') mockServer._errorHandler = handler;
          return mockServer;
        }),
        _errorHandler: null as any,
      };
      vi.mocked(createServer).mockReturnValue(mockServer as any);

      await expect(findAvailablePort(8888)).rejects.toThrow('No available port');
    });
  });

  describe('acquireLock', () => {
    it('acquires lock when file does not exist', () => {
      vi.mocked(existsSync).mockReturnValue(false);
      const result = acquireLock('/tmp/.wigolo');
      expect(result.acquired).toBe(true);
      expect(writeFileSync).toHaveBeenCalled();
    });

    it('fails when lock is held by a live process', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ pid: process.pid }));
      const result = acquireLock('/tmp/.wigolo');
      expect(result.acquired).toBe(false);
      expect(result.existingPid).toBe(process.pid);
    });

    it('cleans stale lock from dead process', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ pid: 999999999 }));
      const result = acquireLock('/tmp/.wigolo');
      expect(result.acquired).toBe(true);
      expect(unlinkSync).toHaveBeenCalled();
    });
  });

  describe('releaseLock', () => {
    it('removes lock file', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      releaseLock('/tmp/.wigolo');
      expect(unlinkSync).toHaveBeenCalled();
    });
  });

  describe('start spawn environment', () => {
    it('does NOT pass WIGOLO_API_TOKEN / WIGOLO_API_TOKEN_FILE to the spawned child', async () => {
      process.env.WIGOLO_API_TOKEN = 'daemon-secret';
      process.env.WIGOLO_API_TOKEN_FILE = '/run/secrets/api-token';

      // Fresh lock acquired (no existing instance).
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue('' as unknown as Buffer);

      // Port resolves cleanly.
      const mockNetServer = {
        listen: vi.fn((_port: number, cb: () => void) => { cb(); return mockNetServer; }),
        close: vi.fn((cb: () => void) => { cb(); }),
        address: vi.fn().mockReturnValue({ port: 8888 }),
        on: vi.fn().mockReturnThis(),
      };
      vi.mocked(createServer).mockReturnValue(mockNetServer as any);

      // Capture the spawn env, then throw to abort start() before the health poll.
      let capturedEnv: NodeJS.ProcessEnv | undefined;
      vi.mocked(spawn).mockImplementation(((_bin: string, _args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
        capturedEnv = opts?.env;
        throw new Error('abort-after-capture');
      }) as unknown as typeof spawn);

      const proc = new SearxngProcess('/tmp/.wigolo/searxng', '/tmp/.wigolo');
      await proc.start().catch(() => { /* expected — we threw to short-circuit */ });

      expect(spawn).toHaveBeenCalled();
      expect(capturedEnv).toBeDefined();
      expect(capturedEnv!.WIGOLO_API_TOKEN).toBeUndefined();
      expect(capturedEnv!.WIGOLO_API_TOKEN_FILE).toBeUndefined();
      // Sanity: the settings path merge still applies.
      expect(capturedEnv!.SEARXNG_SETTINGS_PATH).toContain('settings.yml');
    });
  });
});
