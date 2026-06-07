import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { summarizeSetup, probeSetupStatus, defaultProbeDeps, configReferencesLlmKey, type ComponentStatus } from '../../src/cli/tui/actions/setup-status.js';

const base: ComponentStatus[] = [
  { id: 'browser', label: 'browser', required: true, status: 'ok' },
  { id: 'agents', label: 'agents(claude-code)', required: true, status: 'ok' },
  { id: 'search', label: 'search(core)', required: false, status: 'ok' },
  { id: 'embeddings', label: 'embeddings', required: false, status: 'ok', disables: 'find_similar' },
  { id: 'llm', label: 'LLM key', required: false, status: 'ok', disables: 'research/agent' },
];

describe('summarizeSetup', () => {
  it('all ok → exit 0, ready == total', () => {
    const s = summarizeSetup(base);
    expect(s.requiredFailed).toBe(false);
    expect(s.exitCode).toBe(0);
    expect(s.readyCount).toBe(5);
    expect(s.total).toBe(5);
  });

  it('optional embeddings failed → exit 0, names the degradation', () => {
    const s = summarizeSetup(base.map(c => c.id === 'embeddings' ? { ...c, status: 'failed', detail: 'timeout' } : c));
    expect(s.requiredFailed).toBe(false);
    expect(s.exitCode).toBe(0);
    expect(s.lines.join('\n')).toContain('find_similar disabled');
  });

  it('required browser failed → exit 1', () => {
    const s = summarizeSetup(base.map(c => c.id === 'browser' ? { ...c, status: 'failed', detail: 'install failed' } : c));
    expect(s.requiredFailed).toBe(true);
    expect(s.exitCode).toBe(1);
  });

  it('absent optional LLM key renders ⚠ + optional note, not a failure', () => {
    const s = summarizeSetup(base.map(c => c.id === 'llm' ? { ...c, status: 'absent' } : c));
    expect(s.exitCode).toBe(0);
    expect(s.lines.join('\n')).toMatch(/LLM key/);
  });
});

describe('probeSetupStatus', () => {
  const deps = {
    browserInstalled: () => true,
    searchBackend: () => 'core' as const,
    searxngReady: () => false,
    embeddingsInstalled: () => true,
    rerankerInstalled: () => true,
    llmKeyPresent: () => false,
    configuredAgents: () => ['claude-code'],
  };

  it('core backend → search reported ok even when searxng not ready', async () => {
    const comps = await probeSetupStatus(deps);
    const search = comps.find(c => c.id === 'search')!;
    expect(search.status).toBe('ok');
    expect(search.label).toContain('core');
  });

  it('missing browser → required browser failed', async () => {
    const comps = await probeSetupStatus({ ...deps, browserInstalled: () => false });
    const b = comps.find(c => c.id === 'browser')!;
    expect(b.required).toBe(true);
    expect(b.status).toBe('failed');
  });

  it('no LLM key → llm absent + optional', async () => {
    const comps = await probeSetupStatus(deps);
    const llm = comps.find(c => c.id === 'llm')!;
    expect(llm.required).toBe(false);
    expect(llm.status).toBe('absent');
  });

  it('searxng backend but not ready → search degraded (not failed)', async () => {
    const comps = await probeSetupStatus({ ...deps, searchBackend: () => 'searxng' });
    const search = comps.find(c => c.id === 'search')!;
    expect(search.status).toBe('degraded');
    expect(search.required).toBe(false);
  });
});

describe('defaultProbeDeps', () => {
  let dir: string;
  let prevConfig: string | undefined;
  let prevDataDir: string | undefined;
  let prevSearch: string | undefined;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wigolo-probe-'));
    prevConfig = process.env.WIGOLO_CONFIG_PATH;
    prevDataDir = process.env.WIGOLO_DATA_DIR;
    prevSearch = process.env.WIGOLO_SEARCH;
    process.env.WIGOLO_CONFIG_PATH = join(dir, 'config.json');
    process.env.WIGOLO_DATA_DIR = dir;
    delete process.env.WIGOLO_SEARCH;
    // Both config layers cache per-process — reset so the probe reads fresh
    // from the temp dir/disk rather than a prior test's state.
    const { resetPersistedConfig } = await import('../../src/persisted-config.js');
    const { resetConfig } = await import('../../src/config.js');
    resetPersistedConfig();
    resetConfig();
  });

  afterEach(async () => {
    if (prevConfig === undefined) delete process.env.WIGOLO_CONFIG_PATH;
    else process.env.WIGOLO_CONFIG_PATH = prevConfig;
    if (prevDataDir === undefined) delete process.env.WIGOLO_DATA_DIR;
    else process.env.WIGOLO_DATA_DIR = prevDataDir;
    if (prevSearch === undefined) delete process.env.WIGOLO_SEARCH;
    else process.env.WIGOLO_SEARCH = prevSearch;
    rmSync(dir, { recursive: true, force: true });
    // Drop the temp-dir-bound caches so later test files start clean.
    const { resetPersistedConfig } = await import('../../src/persisted-config.js');
    const { resetConfig } = await import('../../src/config.js');
    resetPersistedConfig();
    resetConfig();
  });

  // Regression guard for the ESM-require bug: a bare `require` (no createRequire
  // shim) throws ReferenceError at runtime under pure ESM, so this would crash.
  // Point config/data dir at an empty temp dir so the on-disk checks are safe.
  it('returns 7 callable members that invoke without throwing', () => {
    const deps = defaultProbeDeps();
    const members = [
      'browserInstalled',
      'searchBackend',
      'searxngReady',
      'embeddingsInstalled',
      'rerankerInstalled',
      'llmKeyPresent',
      'configuredAgents',
    ] as const;

    for (const m of members) {
      expect(typeof deps[m]).toBe('function');
      expect(() => deps[m]()).not.toThrow();
    }
  });

});

// Honest-summary regression: a key persisted on a prior run is referenced by a
// `<field>KeyLocation` pointer in config (propagation.ts), never by the raw
// value. The probe must recognize that pointer or it falsely reports "LLM key
// absent" on every env-less re-run after a headless install stored the key.
describe('configReferencesLlmKey', () => {
  it('recognizes a persisted llmApiKeyKeyLocation pointer', () => {
    expect(configReferencesLlmKey({ settings: { llmApiKeyKeyLocation: 'keychain' } })).toBe(true);
    expect(configReferencesLlmKey({ settings: { llmApiKeyKeyLocation: 'file' } })).toBe(true);
  });

  it('recognizes a legacy provider.keyLocation reference', () => {
    expect(configReferencesLlmKey({ provider: { keyLocation: 'keychain' }, settings: {} })).toBe(true);
  });

  it('recognizes a direct llmApiKey settings reference', () => {
    expect(configReferencesLlmKey({ settings: { llmApiKey: 'ref' } })).toBe(true);
  });

  it('returns false when no key, pointer, or reference is present', () => {
    expect(configReferencesLlmKey({ settings: {} })).toBe(false);
    expect(configReferencesLlmKey({ settings: { llmApiKeyKeyLocation: '' } })).toBe(false);
    expect(configReferencesLlmKey({ provider: {}, settings: {} })).toBe(false);
  });
});
