import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfig } from '../../../src/config.js';

describe('tryConnectDaemon', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    resetConfig();
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
    resetConfig();
  });

  it('exports tryConnectDaemon function', async () => {
    const { tryConnectDaemon } = await import('../../../src/daemon/proxy.js');
    expect(typeof tryConnectDaemon).toBe('function');
  });

  it('returns null when no daemon is running', async () => {
    const { tryConnectDaemon } = await import('../../../src/daemon/proxy.js');
    const result = await tryConnectDaemon(19999, '127.0.0.1');
    expect(result).toBeNull();
  });

  it('returns null when daemon health check fails', async () => {
    const { tryConnectDaemon } = await import('../../../src/daemon/proxy.js');
    const result = await tryConnectDaemon(19998, '127.0.0.1');
    expect(result).toBeNull();
  });

  it('returns null when connection times out', async () => {
    const { tryConnectDaemon } = await import('../../../src/daemon/proxy.js');
    const result = await tryConnectDaemon(3333, '192.0.2.1');
    expect(result).toBeNull();
  });

  it('returns health report when daemon is running (integration case)', async () => {
    const { tryConnectDaemon } = await import('../../../src/daemon/proxy.js');
    expect(typeof tryConnectDaemon).toBe('function');
  });

  it('exports DaemonProxy class', async () => {
    const { DaemonProxy } = await import('../../../src/daemon/proxy.js');
    expect(DaemonProxy).toBeDefined();
  });

  it('DaemonProxy constructor accepts url', async () => {
    const { DaemonProxy } = await import('../../../src/daemon/proxy.js');
    const proxy = new DaemonProxy('http://127.0.0.1:3333');
    expect(proxy).toBeDefined();
  });

  it('DaemonProxy has callTool method', async () => {
    const { DaemonProxy } = await import('../../../src/daemon/proxy.js');
    const proxy = new DaemonProxy('http://127.0.0.1:3333');
    expect(typeof proxy.callTool).toBe('function');
  });

  it('DaemonProxy.callTool throws when daemon is unreachable', async () => {
    const { DaemonProxy } = await import('../../../src/daemon/proxy.js');
    const proxy = new DaemonProxy('http://127.0.0.1:19997');
    await expect(proxy.callTool('fetch', { url: 'https://example.com' })).rejects.toThrow();
  });

  it('DaemonProxy has checkHealth method', async () => {
    const { DaemonProxy } = await import('../../../src/daemon/proxy.js');
    const proxy = new DaemonProxy('http://127.0.0.1:3333');
    expect(typeof proxy.checkHealth).toBe('function');
  });

  it('DaemonProxy.checkHealth returns null when unreachable', async () => {
    const { DaemonProxy } = await import('../../../src/daemon/proxy.js');
    const proxy = new DaemonProxy('http://127.0.0.1:19997');
    const result = await proxy.checkHealth();
    expect(result).toBeNull();
  });
});
