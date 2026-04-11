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

import { findAvailablePort, acquireLock, releaseLock } from '../../../src/searxng/process.js';
import { createServer } from 'node:net';
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
});
