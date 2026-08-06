/**
 * Unit tests for `applyHeadlessSet` — the action behind `wigolo config --set`.
 *
 * Why: the headless surface for non-interactive updates has to mirror the same
 * validation + agent-propagation contract the interactive TUI uses, but stay
 * defensible against shell-history secret leaks and unknown keys. These tests
 * use injected stubs for fs/store/save so we never touch the real filesystem.
 */
import { describe, expect, it, vi } from 'vitest';
import { applyHeadlessSet } from '../../../../../src/cli/tui/actions/headless-set.js';
import type { CategoryDef } from '../../../../../src/cli/tui/schema/types.js';
import { createSettingsStore } from '../../../../../src/cli/tui/state/settings-store.js';
import type {
  SaveResult,
  SecretStore,
} from '../../../../../src/cli/tui/state/propagation.js';
import type { AgentTarget } from '../../../../../src/cli/tui/state/agent-targets.js';

const stubSecretStore: SecretStore = {
  set: vi.fn().mockResolvedValue({ location: 'file' }),
  get: vi.fn().mockResolvedValue(null),
  remove: vi.fn().mockResolvedValue(undefined),
};

const stubAgent: AgentTarget = {
  id: 'claude-code',
  label: 'Claude Code',
  configPath: '/tmp/claude.json',
  serverPath: ['mcpServers', 'wigolo'],
  envPath: ['mcpServers', 'wigolo', 'env'],
  detect: () => Promise.resolve(true),
  backupDir: () => '/tmp/backups',
};

const CATALOG: ReadonlyArray<CategoryDef> = [
  {
    id: 'search',
    label: 'Search',
    description: 'Search backend',
    fields: [
      {
        key: 'WIGOLO_SEARCH',
        settingsPath: 'searchBackend',
        label: 'Search backend',
        kind: 'select',
        options: [
          { value: 'core', label: 'core' },
          { value: 'searxng', label: 'SearXNG' },
          { value: 'hybrid', label: 'hybrid' },
        ],
        default: 'core',
        validate: (v) =>
          typeof v === 'string' && ['core', 'searxng', 'hybrid'].includes(v)
            ? null
            : 'expected one of core|searxng|hybrid',
      },
      {
        key: 'WIGOLO_MAX_BROWSERS',
        settingsPath: 'maxBrowsers',
        label: 'Max browsers',
        kind: 'number',
        default: 3,
        min: 1,
        max: 16,
        validate: (v) =>
          typeof v === 'number' && v >= 1 && v <= 16
            ? null
            : 'expected integer 1..16',
      },
    ],
  },
  {
    id: 'llm',
    label: 'LLM',
    description: 'Provider keys',
    fields: [
      {
        key: 'BRAVE_API_KEY',
        settingsPath: 'braveApiKey',
        label: 'Brave API key',
        kind: 'masked',
        secret: true,
      },
      {
        key: 'OPENAI_API_KEY',
        settingsPath: 'openaiApiKey',
        label: 'OpenAI key',
        kind: 'text',
        secret: true,
      },
    ],
  },
];

describe('applyHeadlessSet — unknown key', () => {
  it('returns status=unknown_key without writing', async () => {
    const save = vi.fn();
    const result = await applyHeadlessSet({
      key: 'NOT_A_REAL_KEY',
      value: 'whatever',
      configPath: '/tmp/config.json',
      catalog: CATALOG,
      agents: [stubAgent],
      secretStore: stubSecretStore,
      storeFactory: createSettingsStore,
      readSettings: () => ({}),
      save,
    });

    expect(result.status).toBe('unknown_key');
    expect(result.message.toLowerCase()).toContain('unknown setting');
    expect(save).not.toHaveBeenCalled();
  });
});

describe('applyHeadlessSet — secret fields are rejected', () => {
  it('refuses a masked field with a clear shell-history-leak warning', async () => {
    const save = vi.fn();
    const result = await applyHeadlessSet({
      key: 'BRAVE_API_KEY',
      value: 'sk-supersecret',
      configPath: '/tmp/config.json',
      catalog: CATALOG,
      agents: [stubAgent],
      secretStore: stubSecretStore,
      storeFactory: createSettingsStore,
      readSettings: () => ({}),
      save,
    });

    expect(result.status).toBe('secret_rejected');
    expect(result.message.toLowerCase()).toContain('shell-history');
    expect(save).not.toHaveBeenCalled();
  });

  it('refuses a non-masked field that has secret:true (defence in depth)', async () => {
    const save = vi.fn();
    const result = await applyHeadlessSet({
      key: 'OPENAI_API_KEY',
      value: 'sk-also-secret',
      configPath: '/tmp/config.json',
      catalog: CATALOG,
      agents: [stubAgent],
      secretStore: stubSecretStore,
      storeFactory: createSettingsStore,
      readSettings: () => ({}),
      save,
    });

    expect(result.status).toBe('secret_rejected');
    expect(save).not.toHaveBeenCalled();
  });
});

describe('applyHeadlessSet — validation', () => {
  it('returns validation_failed for an invalid select value', async () => {
    const save = vi.fn();
    const result = await applyHeadlessSet({
      key: 'WIGOLO_SEARCH',
      value: 'lycos',
      configPath: '/tmp/config.json',
      catalog: CATALOG,
      agents: [stubAgent],
      secretStore: stubSecretStore,
      storeFactory: createSettingsStore,
      readSettings: () => ({}),
      save,
    });

    expect(result.status).toBe('validation_failed');
    expect(result.message).toContain('WIGOLO_SEARCH');
    expect(save).not.toHaveBeenCalled();
  });

  it('returns validation_failed for an out-of-range number', async () => {
    const save = vi.fn();
    const result = await applyHeadlessSet({
      key: 'WIGOLO_MAX_BROWSERS',
      value: '99',
      configPath: '/tmp/config.json',
      catalog: CATALOG,
      agents: [stubAgent],
      secretStore: stubSecretStore,
      storeFactory: createSettingsStore,
      readSettings: () => ({}),
      save,
    });

    expect(result.status).toBe('validation_failed');
    expect(save).not.toHaveBeenCalled();
  });
});

describe('applyHeadlessSet — settingsPath keys (issue #256)', () => {
  it("accepts the settingsPath name 'searchBackend' and saves hybrid", async () => {
    let capturedDirty: Record<string, unknown> = {};
    const fakeSave = vi.fn(async (opts: {
      store: { getPending: () => Record<string, unknown>; commit: () => void };
    }): Promise<SaveResult> => {
      capturedDirty = opts.store.getPending();
      opts.store.commit();
      return { saved: ['searchBackend'], propagated: ['claude-code'], failed: [] };
    });

    const result = await applyHeadlessSet({
      key: 'searchBackend',
      value: 'hybrid',
      configPath: '/tmp/config.json',
      catalog: CATALOG,
      agents: [stubAgent],
      secretStore: stubSecretStore,
      storeFactory: createSettingsStore,
      readSettings: () => ({}),
      save: fakeSave,
    });

    expect(result.status).toBe('ok');
    expect(result.saved).toEqual(['searchBackend']);
    expect(capturedDirty).toEqual({ searchBackend: 'hybrid' });
    expect(fakeSave).toHaveBeenCalledOnce();
  });

  it("still accepts the env-style key 'WIGOLO_SEARCH'", async () => {
    let capturedDirty: Record<string, unknown> = {};
    const fakeSave = vi.fn(async (opts: {
      store: { getPending: () => Record<string, unknown>; commit: () => void };
    }): Promise<SaveResult> => {
      capturedDirty = opts.store.getPending();
      opts.store.commit();
      return { saved: ['searchBackend'], propagated: ['claude-code'], failed: [] };
    });

    const result = await applyHeadlessSet({
      key: 'WIGOLO_SEARCH',
      value: 'hybrid',
      configPath: '/tmp/config.json',
      catalog: CATALOG,
      agents: [stubAgent],
      secretStore: stubSecretStore,
      storeFactory: createSettingsStore,
      readSettings: () => ({}),
      save: fakeSave,
    });

    expect(result.status).toBe('ok');
    expect(result.saved).toEqual(['searchBackend']);
    expect(capturedDirty).toEqual({ searchBackend: 'hybrid' });
  });
});

describe('applyHeadlessSet — happy path', () => {
  it('coerces a number-kind field and calls save with the staged value', async () => {
    let capturedDirty: Record<string, unknown> = {};
    const fakeSave = vi.fn(async (opts: Parameters<typeof applyHeadlessSet>[0]['save'] extends infer T ? Parameters<NonNullable<T>>[0] : never): Promise<SaveResult> => {
      capturedDirty = opts.store.getPending();
      opts.store.commit();
      return { saved: ['maxBrowsers'], propagated: ['claude-code'], failed: [] };
    });

    const result = await applyHeadlessSet({
      key: 'WIGOLO_MAX_BROWSERS',
      value: '6',
      configPath: '/tmp/config.json',
      catalog: CATALOG,
      agents: [stubAgent],
      secretStore: stubSecretStore,
      storeFactory: createSettingsStore,
      readSettings: () => ({ maxBrowsers: 3 }),
      save: fakeSave,
    });

    expect(result.status).toBe('ok');
    expect(result.saved).toEqual(['maxBrowsers']);
    expect(result.propagated).toEqual(['claude-code']);
    expect(capturedDirty).toEqual({ maxBrowsers: 6 });
    expect(result.message).toContain('claude-code');
  });

  it('reports per-agent propagation failures alongside the saved key', async () => {
    const fakeSave = vi.fn(async (): Promise<SaveResult> => ({
      saved: ['searchBackend'],
      propagated: ['claude-code'],
      failed: [{ agentId: 'vscode', reason: 'EACCES' }],
    }));

    const result = await applyHeadlessSet({
      key: 'WIGOLO_SEARCH',
      value: 'hybrid',
      configPath: '/tmp/config.json',
      catalog: CATALOG,
      agents: [stubAgent],
      secretStore: stubSecretStore,
      storeFactory: createSettingsStore,
      readSettings: () => ({}),
      save: fakeSave,
    });

    expect(result.status).toBe('ok');
    expect(result.failed).toEqual([{ agentId: 'vscode', reason: 'EACCES' }]);
    expect(result.message).toContain('vscode');
    expect(result.message).toContain('EACCES');
  });

  it('reports no-op when the staged value matches what is already persisted', async () => {
    const fakeSave = vi.fn();
    const result = await applyHeadlessSet({
      key: 'WIGOLO_SEARCH',
      value: 'core',
      configPath: '/tmp/config.json',
      catalog: CATALOG,
      agents: [stubAgent],
      secretStore: stubSecretStore,
      storeFactory: createSettingsStore,
      readSettings: () => ({ searchBackend: 'core' }),
      save: fakeSave,
    });

    expect(result.status).toBe('ok');
    expect(fakeSave).not.toHaveBeenCalled();
    expect(result.message.toLowerCase()).toContain('no change');
  });
});

describe('applyHeadlessSet — persist failures propagate', () => {
  it('returns persist_failed when save throws', async () => {
    const result = await applyHeadlessSet({
      key: 'WIGOLO_SEARCH',
      value: 'hybrid',
      configPath: '/tmp/config.json',
      catalog: CATALOG,
      agents: [stubAgent],
      secretStore: stubSecretStore,
      storeFactory: createSettingsStore,
      readSettings: () => ({}),
      save: async () => {
        throw new Error('disk full');
      },
    });

    expect(result.status).toBe('persist_failed');
    expect(result.message).toContain('disk full');
  });

  it('surfaces save() errors as validation_failed when reported in errors[]', async () => {
    const result = await applyHeadlessSet({
      key: 'WIGOLO_SEARCH',
      value: 'hybrid',
      configPath: '/tmp/config.json',
      catalog: CATALOG,
      agents: [stubAgent],
      secretStore: stubSecretStore,
      storeFactory: createSettingsStore,
      readSettings: () => ({}),
      save: async () => ({
        saved: [],
        propagated: [],
        failed: [],
        errors: [{ key: 'searchBackend', reason: 'late validator caught this' }],
      }),
    });

    expect(result.status).toBe('validation_failed');
    expect(result.message).toContain('late validator caught this');
  });
});
