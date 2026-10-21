/**
 * resolveEntry — required-fields routing.
 *
 * When mode='auto' (used by `wigolo config`), resolveEntry checks not only
 * whether the config file exists but whether it has the required LLM fields.
 * A file that exists but lacks llmProvider or llmApiKey routes to 'wizard'.
 *
 * mode='wizard' (used by `wigolo init` / --force-wizard) always routes to
 * wizard regardless of config contents.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveEntry } from '../../../../src/cli/tui/entry.js';
import { resetPersistedConfig } from '../../../../src/persisted-config.js';

let tmpDir: string;

function writeCfg(file: string, settings: Record<string, unknown>): string {
  const p = join(tmpDir, file);
  writeFileSync(p, JSON.stringify({ version: 1, settings }), { mode: 0o600 });
  return p;
}

function writePersistedCfg(file: string, config: Record<string, unknown>): string {
  const p = join(tmpDir, file);
  writeFileSync(p, JSON.stringify({ version: 1, ...config }), { mode: 0o600 });
  return p;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'wigolo-entry-rf-'));
});

afterEach(() => {
  resetPersistedConfig();   // bust the per-path cache
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('resolveEntry auto-routing with required-fields check', () => {
  it('config exists + has required fields → home', async () => {
    const p = writeCfg('ok.json', { llmProvider: 'anthropic', llmApiKey: 'sk-xxx' });
    const r = await resolveEntry({ mode: 'auto', configPath: p, isTTY: true });
    expect(r.mode).toBe('home');
    expect(r.firstRun).toBe(false);
  });

  it('config with a secret-location reference → home without persisting the key', async () => {
    const p = writeCfg('key-reference.json', {
      llmProvider: 'anthropic',
      llmApiKeyKeyLocation: 'keychain',
    });
    const r = await resolveEntry({ mode: 'auto', configPath: p, isTTY: true });
    expect(r.mode).toBe('home');
  });

  it('legacy provider block with a matching provider → home', async () => {
    const p = writePersistedCfg('legacy-provider.json', {
      settings: { llmProvider: 'openai' },
      provider: { name: 'openai', keyLocation: 'file' },
    });
    const r = await resolveEntry({ mode: 'auto', configPath: p, isTTY: true });
    expect(r.mode).toBe('home');
  });

  it('config exists but missing llmProvider → wizard', async () => {
    const p = writeCfg('no-provider.json', { llmApiKey: 'sk-xxx' });
    const r = await resolveEntry({ mode: 'auto', configPath: p, isTTY: true });
    expect(r.mode).toBe('wizard');
  });

  it('config exists but missing llmApiKey → wizard', async () => {
    const p = writeCfg('no-key.json', { llmProvider: 'anthropic' });
    const r = await resolveEntry({ mode: 'auto', configPath: p, isTTY: true });
    expect(r.mode).toBe('wizard');
  });

  it('config exists but both fields empty strings → wizard', async () => {
    const p = writeCfg('empty-fields.json', { llmProvider: '', llmApiKey: '' });
    const r = await resolveEntry({ mode: 'auto', configPath: p, isTTY: true });
    expect(r.mode).toBe('wizard');
  });

  it('config missing entirely → wizard (same as before)', async () => {
    const p = join(tmpDir, 'nonexistent.json');
    const r = await resolveEntry({ mode: 'auto', configPath: p, isTTY: true });
    expect(r.mode).toBe('wizard');
    expect(r.firstRun).toBe(true);
  });

  it('mode=wizard bypasses required-fields check — always wizard', async () => {
    const p = writeCfg('complete.json', { llmProvider: 'anthropic', llmApiKey: 'sk-xxx' });
    const r = await resolveEntry({ mode: 'wizard', configPath: p, isTTY: true });
    expect(r.mode).toBe('wizard');
  });

  it('mode=home bypasses required-fields check — always home', async () => {
    const p = writeCfg('empty-settings.json', {});
    const r = await resolveEntry({ mode: 'home', configPath: p, isTTY: true });
    expect(r.mode).toBe('home');
  });
});
