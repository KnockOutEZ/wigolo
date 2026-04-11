import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfig } from '../../../src/config.js';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    rmSync: vi.fn(),
  };
});

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { checkPythonAvailable, checkDockerAvailable, getBootstrapState, setBootstrapState, generateSettings, resolveSearchBackend } from '../../../src/searxng/bootstrap.js';

describe('SearXNG bootstrap', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    resetConfig();
    vi.clearAllMocks();
  });

  afterEach(() => { process.env = originalEnv; resetConfig(); });

  describe('checkPythonAvailable', () => {
    it('returns true when python3 is available', () => {
      vi.mocked(execSync).mockReturnValue(Buffer.from('Python 3.11.0'));
      expect(checkPythonAvailable()).toBe(true);
    });

    it('returns false when python3 is not found', () => {
      vi.mocked(execSync).mockImplementation(() => { throw new Error('not found'); });
      expect(checkPythonAvailable()).toBe(false);
    });
  });

  describe('checkDockerAvailable', () => {
    it('returns true when docker is available', () => {
      vi.mocked(execSync).mockReturnValue(Buffer.from('Docker version 24.0.0'));
      expect(checkDockerAvailable()).toBe(true);
    });

    it('returns false when docker is not found', () => {
      vi.mocked(execSync).mockImplementation(() => { throw new Error('not found'); });
      expect(checkDockerAvailable()).toBe(false);
    });
  });

  describe('getBootstrapState', () => {
    it('returns null when state file does not exist', () => {
      vi.mocked(existsSync).mockReturnValue(false);
      expect(getBootstrapState('/tmp/.wigolo')).toBeNull();
    });

    it('reads state from state.json', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ status: 'ready', searxngPath: '/tmp/.wigolo/searxng' }));
      const state = getBootstrapState('/tmp/.wigolo');
      expect(state?.status).toBe('ready');
    });
  });

  describe('setBootstrapState', () => {
    it('writes state to state.json', () => {
      setBootstrapState('/tmp/.wigolo', { status: 'ready', searxngPath: '/tmp/.wigolo/searxng' });
      expect(writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('state.json'),
        expect.stringContaining('"status":"ready"'),
      );
    });
  });

  describe('generateSettings', () => {
    it('returns valid YAML content with JSON format enabled', () => {
      const settings = generateSettings(8888);
      expect(settings).toContain('json');
      expect(settings).toContain('8888');
      expect(settings).toContain('127.0.0.1');
    });
  });

  describe('resolveSearchBackend', () => {
    it('returns user-provided URL when SEARXNG_URL is set', async () => {
      process.env.SEARXNG_URL = 'http://my-searxng:8080';
      resetConfig();
      const result = await resolveSearchBackend();
      expect(result.type).toBe('external');
      expect(result.url).toBe('http://my-searxng:8080');
    });

    it('returns ready state when state.json says ready', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ status: 'ready', searxngPath: '/tmp/.wigolo/searxng' }));
      const result = await resolveSearchBackend();
      expect(result.type).toBe('native');
    });

    it('returns fallback when state is failed and no Docker', async () => {
      vi.mocked(existsSync).mockImplementation((p) => String(p).includes('state.json'));
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ status: 'failed' }));
      vi.mocked(execSync).mockImplementation(() => { throw new Error('not found'); });
      const result = await resolveSearchBackend();
      expect(result.type).toBe('scraping');
    });
  });
});
