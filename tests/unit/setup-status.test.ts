import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { summarizeSetup, probeSetupStatus, defaultProbeDeps, configReferencesLlmKey, glyph, type ComponentStatus } from '../../src/cli/tui/actions/setup-status.js';

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

  it('a REQUIRED lazy component does not fail setup (lazy acquisition)', () => {
    // A required-but-lazy component (P0 lazy acquisition) is acquired on first
    // use — it must not fail the setup nor flip the exit code to 1.
    const s = summarizeSetup(
      base.map(c => c.id === 'agents' ? { ...c, status: 'lazy', required: true } : c),
    );
    expect(s.requiredFailed).toBe(false);
    expect(s.exitCode).toBe(0);
  });

  it('a REQUIRED skipped component does not fail setup (engine-only)', () => {
    const s = summarizeSetup(
      base.map(c => c.id === 'agents' ? { ...c, status: 'skipped', required: false } : c),
    );
    expect(s.requiredFailed).toBe(false);
    expect(s.exitCode).toBe(0);
  });
});

describe('glyph', () => {
  it('maps lazy and skipped to the neutral ○, not the ✗ failure glyph', () => {
    expect(glyph('lazy')).toBe('○');
    expect(glyph('skipped')).toBe('○');
    expect(glyph('failed')).toBe('✗');
    expect(glyph('ok')).toBe('✓');
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

  it('missing browser → lazy (self-installs on first use), not a setup failure', async () => {
    // WHY (updated for wave-2 S8): the probe must still surface a missing
    // browser distinctly — but a missing browser now triggers a background
    // install on first fetch use, so it renders ○ lazy with the warmup hint
    // and must not fail setup or flip the exit code.
    const comps = await probeSetupStatus({ ...deps, browserInstalled: () => false });
    const b = comps.find(c => c.id === 'browser')!;
    expect(b.required).toBe(true);
    expect(b.status).toBe('lazy');
    expect(b.detail).toMatch(/first use/);
    expect(b.detail).toMatch(/wigolo warmup --browser/);
    const summary = summarizeSetup(comps);
    expect(summary.requiredFailed).toBe(false);
    expect(summary.exitCode).toBe(0);
    const line = summary.lines.find(l => l.includes('browser'))!;
    expect(line).toContain('○');
    expect(line).not.toContain('✗');
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

  it('agents configured → agents ok (regardless of agentsRequested)', async () => {
    const comps = await probeSetupStatus(deps, { agentsRequested: false });
    const a = comps.find(c => c.id === 'agents')!;
    expect(a.status).toBe('ok');
    expect(a.required).toBe(true);
  });

  // Case (a): engine-only mode. No agents were requested, so a bare engine
  // install is a deliberate, valid choice — NOT a failure.
  it('engine-only (agentsRequested=false) + no agents → skipped, not required, not failed', async () => {
    const comps = await probeSetupStatus(
      { ...deps, configuredAgents: () => [] },
      { agentsRequested: false },
    );
    const a = comps.find(c => c.id === 'agents')!;
    expect(a.required).toBe(false);
    expect(a.status).toBe('skipped');
    expect(a.detail).toMatch(/engine-only/);
    expect(a.detail).toMatch(/npx wigolo mcp/);
    // A skipped agents component must not fail the setup.
    const summary = summarizeSetup(comps);
    expect(summary.requiredFailed).toBe(false);
    expect(summary.exitCode).toBe(0);
  });

  // Case (b): the guard must NOT go vacuous. Agents WERE requested but none got
  // registered → that is a genuine required-component failure.
  it('agents requested but none configured → required failure (guard not vacuous)', async () => {
    const comps = await probeSetupStatus(
      { ...deps, configuredAgents: () => [] },
      { agentsRequested: true },
    );
    const a = comps.find(c => c.id === 'agents')!;
    expect(a.required).toBe(true);
    expect(a.status).toBe('failed');
    expect(a.detail).toBe('no agent configured');
    const summary = summarizeSetup(comps);
    expect(summary.requiredFailed).toBe(true);
    expect(summary.exitCode).toBe(1);
  });

  it('agentsRequested defaults to true (omitted options) → empty agents fail', async () => {
    // Safety default: an options-less caller must keep the failure guard, never
    // silently treat a missing agent as engine-only.
    const comps = await probeSetupStatus({ ...deps, configuredAgents: () => [] });
    const a = comps.find(c => c.id === 'agents')!;
    expect(a.required).toBe(true);
    expect(a.status).toBe('failed');
  });

  // Case (c): a missing embedding model is lazily acquired on first use — it is
  // not a failure glyph, and the detail names the warmup flag.
  it('missing embedding model → lazy (not failed), detail names warmup --embeddings', async () => {
    const comps = await probeSetupStatus({ ...deps, embeddingsInstalled: () => false });
    const e = comps.find(c => c.id === 'embeddings')!;
    expect(e.status).toBe('lazy');
    expect(e.required).toBe(false);
    expect(e.detail).toMatch(/first use/);
    expect(e.detail).toMatch(/wigolo warmup --embeddings/);
    // Lazy embeddings must not fail the setup, and must not render the ✗ glyph
    // nor the "find_similar disabled" suffix.
    const summary = summarizeSetup(comps);
    expect(summary.requiredFailed).toBe(false);
    expect(summary.exitCode).toBe(0);
    const embLine = summary.lines.find(l => l.includes('embeddings'))!;
    expect(embLine).not.toContain('✗');
    expect(embLine).toContain('○');
    expect(embLine).not.toContain('find_similar disabled');
  });

  // Genuinely fresh machine: no browser, no embeddings, engine-only install.
  // Every lazily-acquired component self-installs on first use, so a bare
  // `wigolo init --non-interactive` must succeed — exit 0, both rows ○ lazy.
  it('fresh machine (no browser, no embeddings, engine-only) → exit 0, both ○ lazy', async () => {
    const comps = await probeSetupStatus(
      {
        ...deps,
        browserInstalled: () => false,
        embeddingsInstalled: () => false,
        configuredAgents: () => [],
      },
      { agentsRequested: false },
    );
    const browser = comps.find(c => c.id === 'browser')!;
    const embeddings = comps.find(c => c.id === 'embeddings')!;
    expect(browser.status).toBe('lazy');
    expect(embeddings.status).toBe('lazy');

    const summary = summarizeSetup(comps);
    expect(summary.requiredFailed).toBe(false);
    expect(summary.exitCode).toBe(0);
    const browserLine = summary.lines.find(l => l.includes('browser'))!;
    const embLine = summary.lines.find(l => l.includes('embeddings'))!;
    expect(browserLine).toContain('○');
    expect(browserLine).not.toContain('✗');
    expect(embLine).toContain('○');
    expect(embLine).not.toContain('✗');
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
