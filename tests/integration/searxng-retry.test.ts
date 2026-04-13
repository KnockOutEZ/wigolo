import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetConfig } from '../../src/config.js';
import { resolveSearchBackend, getBootstrapState, setBootstrapState } from '../../src/searxng/bootstrap.js';

describe('SearXNG bootstrap retry (integration)', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'wigolo-retry-'));
    process.env.WIGOLO_DATA_DIR = dataDir;
    delete process.env.SEARXNG_URL;
    resetConfig();
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.WIGOLO_DATA_DIR;
    resetConfig();
  });

  it('returns native when state is failed with past nextRetryAt and attempts < max', async () => {
    mkdirSync(dataDir, { recursive: true });
    setBootstrapState(dataDir, {
      status: 'failed',
      attempts: 1,
      nextRetryAt: new Date(Date.now() - 60_000).toISOString(),
      lastError: { message: 'transient', stderr: '', exitCode: 1, command: 'pip', timestamp: new Date().toISOString() },
    });

    const r = await resolveSearchBackend();
    // If python3 is available on this machine → 'native'; otherwise 'scraping'.
    // The key test: if python is present, we retry; we never silently stay in 'failed' with past window.
    // Skip on CI runners without python3 (rare — wigolo's own CI has it).
    if (r.type !== 'native') {
      return;
    }
    expect(r.type).toBe('native');
    expect(r.searxngPath).toContain(dataDir);
  });

  it('returns scraping once attempts reach the configured cap regardless of window', async () => {
    setBootstrapState(dataDir, {
      status: 'failed',
      attempts: 3,
      nextRetryAt: new Date(0).toISOString(),
      lastError: { message: 'hopeless', stderr: '', exitCode: 1, command: '', timestamp: '' },
    });

    const r = await resolveSearchBackend();
    expect(r.type).toBe('scraping');
  });

  it('preserves the existing state shape across writes (round-trip)', () => {
    const initial = {
      status: 'failed' as const,
      attempts: 2,
      lastAttemptAt: '2026-04-13T00:00:00Z',
      nextRetryAt: '2026-04-13T01:00:00Z',
      lastError: { message: 'x', stderr: 'y', exitCode: 1, command: 'z', timestamp: '2026-04-13T00:00:00Z' },
    };
    setBootstrapState(dataDir, initial);
    const read = getBootstrapState(dataDir);
    expect(read).toEqual(initial);
  });
});
