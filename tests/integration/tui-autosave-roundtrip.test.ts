/**
 * Integration test: autosave disk round-trip.
 *
 * MUST NOT mock persistKey, writePersistedConfig, or readPersistedConfig.
 * Writes to a real temp file, reads back, and asserts the nested shape.
 *
 * The old (buggy) persistKey wrote { settings: { "llm.apiKey": "x" } } —
 * a flat dotted-string key. This test catches that regression: it asserts
 * the nested shape AND that the flat-dotted key is absent.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPersistedConfig, resetPersistedConfig } from '../../src/persisted-config.js';
import { persistKey } from '../../src/cli/tui/actions/write-config.js';

describe('autosave disk round-trip', () => {
  let tmpDir: string;
  let tmpConfig: string;
  let originalConfigPath: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'wigolo-autosave-'));
    tmpConfig = join(tmpDir, 'config.json');
    // Point defaultConfigPath at tmpConfig via the env var it reads.
    originalConfigPath = process.env.WIGOLO_CONFIG_PATH;
    process.env.WIGOLO_CONFIG_PATH = tmpConfig;
    // Clear the in-process cache so each test starts from an empty file.
    resetPersistedConfig();
  });

  afterEach(() => {
    if (originalConfigPath === undefined) {
      delete process.env.WIGOLO_CONFIG_PATH;
    } else {
      process.env.WIGOLO_CONFIG_PATH = originalConfigPath;
    }
    resetPersistedConfig();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('persistKey writes nested shape that reads back correctly', async () => {
    await persistKey('llm.apiKey', 'sk-test-123');
    resetPersistedConfig(); // bust cache so we read from disk
    const cfg = readPersistedConfig(tmpConfig);
    // Must be nested — not a flat dotted key
    expect((cfg.settings as Record<string, unknown>)?.llm).toBeDefined();
    expect(
      ((cfg.settings as Record<string, unknown>)?.llm as Record<string, unknown>)?.apiKey,
    ).toBe('sk-test-123');
    // The old buggy flat-dotted key must not exist
    expect((cfg.settings as Record<string, unknown>)?.['llm.apiKey']).toBeUndefined();
  });

  it('multiple persistKey calls preserve earlier nested values', async () => {
    await persistKey('llm.apiKey', 'sk-1');
    await persistKey('llm.provider', 'anthropic');
    await persistKey('browser.engine', 'chromium');
    resetPersistedConfig();
    const cfg = readPersistedConfig(tmpConfig);
    const s = cfg.settings as Record<string, unknown>;
    expect((s.llm as Record<string, unknown>)?.apiKey).toBe('sk-1');
    expect((s.llm as Record<string, unknown>)?.provider).toBe('anthropic');
    expect((s.browser as Record<string, unknown>)?.engine).toBe('chromium');
  });

  it('overwriting a nested key updates only that leaf', async () => {
    await persistKey('llm.apiKey', 'sk-first');
    await persistKey('llm.provider', 'anthropic');
    await persistKey('llm.apiKey', 'sk-second');
    resetPersistedConfig();
    const cfg = readPersistedConfig(tmpConfig);
    const s = cfg.settings as Record<string, unknown>;
    expect((s.llm as Record<string, unknown>)?.apiKey).toBe('sk-second');
    expect((s.llm as Record<string, unknown>)?.provider).toBe('anthropic');
  });
});
