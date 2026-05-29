import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, symlinkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  save,
  uninstallAgent,
  type AgentTarget,
  type SecretStore,
  type WritableFs,
  defaultWritableFs,
} from '../../../../../src/cli/tui/state/propagation.js';
import { createSettingsStore } from '../../../../../src/cli/tui/state/settings-store.js';
import type { CategoryDef } from '../../../../../src/cli/tui/schema/types.js';

// In-memory secret store for test isolation
function makeSecretStore(): SecretStore & { _values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    _values: values,
    async set(key, value) {
      values.set(key, value);
      return { location: 'file' };
    },
    async get(key) {
      return values.get(key) ?? null;
    },
    async remove(key) {
      values.delete(key);
    },
  };
}

function makeAgent(
  id: AgentTarget['id'],
  configPath: string,
  backupDir: string,
  serverPath: ReadonlyArray<string>,
): AgentTarget {
  return {
    id,
    label: id,
    configPath,
    serverPath,
    envPath: [...serverPath, 'env'],
    detect: async () => existsSync(configPath),
    backupDir: () => backupDir,
  };
}

function writeAgentConfig(
  configPath: string,
  serverPath: ReadonlyArray<string>,
  serverEntry: Record<string, unknown>,
  extra?: Record<string, unknown>,
): void {
  mkdirSync(join(configPath, '..'), { recursive: true });
  // Build nested structure: { [serverPath[0]]: { [serverPath[1]]: serverEntry, ... } }
  const root: Record<string, unknown> = { ...(extra ?? {}) };
  let cursor: Record<string, unknown> = root;
  for (let i = 0; i < serverPath.length - 1; i++) {
    const key = serverPath[i];
    if (typeof cursor[key] !== 'object' || cursor[key] === null) {
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[serverPath[serverPath.length - 1]] = serverEntry;
  writeFileSync(configPath, JSON.stringify(root, null, 2));
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
}

function navigate(root: Record<string, unknown>, path: ReadonlyArray<string>): unknown {
  let cur: unknown = root;
  for (const key of path) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

const testCatalog: ReadonlyArray<CategoryDef> = [
  {
    id: 'browser',
    label: 'Browser',
    description: 'browser',
    fields: [
      {
        key: 'WIGOLO_BROWSER_TYPES',
        settingsPath: 'browserTypes',
        label: 'Engine',
        kind: 'select',
        options: [{ value: 'chromium', label: 'Chromium' }],
        default: 'chromium',
        validate: (v) => (v === 'chromium' ? null : 'invalid engine'),
      },
      {
        key: 'WIGOLO_MAX_BROWSERS',
        settingsPath: 'maxBrowsers',
        label: 'Max',
        kind: 'number',
        default: 3,
        min: 1,
        max: 16,
        validate: (v) => (typeof v === 'number' && v >= 1 && v <= 16 ? null : 'out of range'),
      },
      {
        key: 'WIGOLO_DATA_DIR',
        settingsPath: 'dataDir',
        label: 'Data dir',
        kind: 'path',
        propagateToAgents: false,
      },
    ],
  },
  {
    id: 'llm',
    label: 'LLM',
    description: 'llm',
    fields: [
      {
        key: 'WIGOLO_LLM_API_KEY',
        settingsPath: 'llmApiKey',
        label: 'API key',
        kind: 'masked',
        secret: true,
      },
    ],
  },
];

describe('propagation.save', () => {
  let tmp: string;
  let configPath: string;
  let backupDir: string;
  let agentAPath: string;
  let agentBPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'wigolo-prop-'));
    configPath = join(tmp, 'config.json');
    backupDir = join(tmp, 'backups');
    agentAPath = join(tmp, 'agent-a.json');
    agentBPath = join(tmp, 'agent-b.json');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('saves 2 non-secret fields, updates both agents, creates backups', async () => {
    writeAgentConfig(agentAPath, ['mcpServers', 'wigolo'], { command: 'npx', args: ['wigolo'], env: { EXISTING: 'keep' } });
    writeAgentConfig(agentBPath, ['servers', 'wigolo'], { command: 'npx', args: ['wigolo'], env: {} });

    const agents: AgentTarget[] = [
      makeAgent('claude-code', agentAPath, backupDir, ['mcpServers', 'wigolo']),
      makeAgent('vscode', agentBPath, backupDir, ['servers', 'wigolo']),
    ];

    const store = createSettingsStore({});
    store.set('browserTypes', 'chromium');
    store.set('maxBrowsers', 5);

    const result = await save({
      store,
      catalog: testCatalog,
      configPath,
      agents,
      secretStore: makeSecretStore(),
    });

    expect(result.errors).toBeUndefined();
    expect(result.saved.sort()).toEqual(['browserTypes', 'maxBrowsers'].sort());
    expect(result.propagated.sort()).toEqual(['claude-code', 'vscode'].sort());
    expect(result.failed).toEqual([]);

    // config.json has the values
    const cfg = readJson(configPath);
    expect((cfg.settings as Record<string, unknown>).browserTypes).toBe('chromium');
    expect((cfg.settings as Record<string, unknown>).maxBrowsers).toBe(5);

    // Both agents have updated env, preserving existing keys
    const aEnv = navigate(readJson(agentAPath), ['mcpServers', 'wigolo', 'env']) as Record<string, unknown>;
    expect(aEnv.WIGOLO_BROWSER_TYPES).toBe('chromium');
    expect(aEnv.WIGOLO_MAX_BROWSERS).toBe('5');
    expect(aEnv.EXISTING).toBe('keep');

    const bEnv = navigate(readJson(agentBPath), ['servers', 'wigolo', 'env']) as Record<string, unknown>;
    expect(bEnv.WIGOLO_BROWSER_TYPES).toBe('chromium');
    expect(bEnv.WIGOLO_MAX_BROWSERS).toBe('5');

    // Backups exist for both agents
    const backupFiles = readdirSync(backupDir);
    expect(backupFiles.some((f) => f.startsWith('claude-code-'))).toBe(true);
    expect(backupFiles.some((f) => f.startsWith('vscode-'))).toBe(true);

    // Store committed
    expect(store.isDirty()).toBe(false);
  });

  it('surfaces per-agent failure but keeps other agents saved', async () => {
    writeAgentConfig(agentAPath, ['mcpServers', 'wigolo'], { command: 'npx', args: ['wigolo'], env: {} });
    writeAgentConfig(agentBPath, ['servers', 'wigolo'], { command: 'npx', args: ['wigolo'], env: {} });

    const agents: AgentTarget[] = [
      makeAgent('claude-code', agentAPath, backupDir, ['mcpServers', 'wigolo']),
      makeAgent('vscode', agentBPath, backupDir, ['servers', 'wigolo']),
    ];

    // Inject WritableFs that throws EACCES on writes to agent B
    const realFs = defaultWritableFs();
    const fs: WritableFs = {
      ...realFs,
      async writeFile(path, data) {
        if (path.startsWith(agentBPath) || path === agentBPath) {
          const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
          err.code = 'EACCES';
          throw err;
        }
        return realFs.writeFile(path, data);
      },
      async rename(from, to) {
        if (to === agentBPath) {
          const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
          err.code = 'EACCES';
          throw err;
        }
        return realFs.rename(from, to);
      },
    };

    const store = createSettingsStore({});
    store.set('browserTypes', 'chromium');

    const result = await save({
      store,
      catalog: testCatalog,
      configPath,
      agents,
      secretStore: makeSecretStore(),
      fs,
    });

    expect(result.saved).toEqual(['browserTypes']);
    expect(result.propagated).toEqual(['claude-code']);
    expect(result.failed.map((f) => f.agentId)).toEqual(['vscode']);
    expect(result.failed[0].reason).toMatch(/EACCES|permission/i);

    // Agent A still updated
    const aEnv = navigate(readJson(agentAPath), ['mcpServers', 'wigolo', 'env']) as Record<string, unknown>;
    expect(aEnv.WIGOLO_BROWSER_TYPES).toBe('chromium');
  });

  it('saves secret field: config.json gets only keyLocation, secretStore gets the value, agent env gets the secret', async () => {
    writeAgentConfig(agentAPath, ['mcpServers', 'wigolo'], { command: 'npx', args: ['wigolo'], env: {} });

    const agents: AgentTarget[] = [
      makeAgent('claude-code', agentAPath, backupDir, ['mcpServers', 'wigolo']),
    ];

    const secrets = makeSecretStore();
    const store = createSettingsStore({});
    store.set('llmApiKey', 'sk-test-abc123');

    const result = await save({
      store,
      catalog: testCatalog,
      configPath,
      agents,
      secretStore: secrets,
    });

    expect(result.saved).toEqual(['llmApiKey']);
    expect(result.propagated).toEqual(['claude-code']);

    // config.json must NOT contain the raw secret
    const cfgRaw = readFileSync(configPath, 'utf-8');
    expect(cfgRaw).not.toContain('sk-test-abc123');

    // SecretStore holds the value (using settingsPath as identifier)
    expect(secrets._values.get('llmApiKey')).toBe('sk-test-abc123');

    // Agent env has the secret value
    const aEnv = navigate(readJson(agentAPath), ['mcpServers', 'wigolo', 'env']) as Record<string, unknown>;
    expect(aEnv.WIGOLO_LLM_API_KEY).toBe('sk-test-abc123');
  });

  it('respects propagateToAgents: false — config.json updated, agent env not touched for that key', async () => {
    writeAgentConfig(agentAPath, ['mcpServers', 'wigolo'], { command: 'npx', args: ['wigolo'], env: { KEEP: 'me' } });

    const agents: AgentTarget[] = [
      makeAgent('claude-code', agentAPath, backupDir, ['mcpServers', 'wigolo']),
    ];

    const store = createSettingsStore({});
    store.set('dataDir', '/custom/path');

    const result = await save({
      store,
      catalog: testCatalog,
      configPath,
      agents,
      secretStore: makeSecretStore(),
    });

    expect(result.saved).toEqual(['dataDir']);

    const cfg = readJson(configPath);
    expect((cfg.settings as Record<string, unknown>).dataDir).toBe('/custom/path');

    const aEnv = navigate(readJson(agentAPath), ['mcpServers', 'wigolo', 'env']) as Record<string, unknown>;
    expect(aEnv.WIGOLO_DATA_DIR).toBeUndefined();
    expect(aEnv.KEEP).toBe('me');
  });

  it('atomicity: rename failure on config.json leaves original file unchanged', async () => {
    // Pre-populate config.json
    mkdirSync(join(tmp), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ version: 1, settings: { browserTypes: 'old' } }, null, 2));

    const realFs = defaultWritableFs();
    const fs: WritableFs = {
      ...realFs,
      async rename(from, to) {
        if (to === configPath) {
          throw new Error('rename failed (simulated)');
        }
        return realFs.rename(from, to);
      },
    };

    const store = createSettingsStore({});
    store.set('browserTypes', 'chromium');

    const result = await save({
      store,
      catalog: testCatalog,
      configPath,
      agents: [],
      secretStore: makeSecretStore(),
      fs,
    });

    // Original file unchanged
    const cfg = readJson(configPath);
    expect((cfg.settings as Record<string, unknown>).browserTypes).toBe('old');

    // Either errors[] is populated or failed[] flags the config write
    const hadConfigError =
      (result.errors?.some((e) => e.reason.match(/rename|simulated/i)) ?? false) ||
      result.failed.some((f) => f.agentId === '__config__');
    expect(hadConfigError).toBe(true);
    expect(result.saved).toEqual([]);
  });

  it('validation failures abort the save and keep pending intact', async () => {
    writeAgentConfig(agentAPath, ['mcpServers', 'wigolo'], { command: 'npx', args: ['wigolo'], env: {} });

    const store = createSettingsStore({});
    store.set('maxBrowsers', 99); // out of range

    const result = await save({
      store,
      catalog: testCatalog,
      configPath,
      agents: [makeAgent('claude-code', agentAPath, backupDir, ['mcpServers', 'wigolo'])],
      secretStore: makeSecretStore(),
    });

    expect(result.saved).toEqual([]);
    expect(result.errors).toBeDefined();
    expect(result.errors!.some((e) => e.key === 'maxBrowsers')).toBe(true);

    // config.json never created
    expect(existsSync(configPath)).toBe(false);

    // Store pending intact
    expect(store.isDirty()).toBe(true);
    expect(store.getPending().maxBrowsers).toBe(99);
  });

  it('uninstallAgent deletes the wigolo entry but leaves rest of file intact', async () => {
    writeAgentConfig(
      agentAPath,
      ['mcpServers', 'wigolo'],
      { command: 'npx', args: ['wigolo'] },
      { mcpServers: { other: { command: 'keep' } } },
    );
    // After writeAgentConfig: mcpServers now has both 'wigolo' and 'other'

    const target = makeAgent('claude-code', agentAPath, backupDir, ['mcpServers', 'wigolo']);
    const result = await uninstallAgent({ target, secretStore: makeSecretStore() });

    expect(result.ok).toBe(true);

    const cfg = readJson(agentAPath);
    const mcp = cfg.mcpServers as Record<string, unknown>;
    expect(mcp.wigolo).toBeUndefined();
    expect(mcp.other).toBeDefined();

    // Backup was created
    expect(existsSync(backupDir)).toBe(true);
    const backups = readdirSync(backupDir);
    expect(backups.some((b) => b.startsWith('claude-code-'))).toBe(true);
  });

  it('backup retention: only last 5 backups per agent kept', async () => {
    writeAgentConfig(agentAPath, ['mcpServers', 'wigolo'], { command: 'npx', args: ['wigolo'], env: {} });
    const agents: AgentTarget[] = [
      makeAgent('claude-code', agentAPath, backupDir, ['mcpServers', 'wigolo']),
    ];

    // 6 saves, each bumping a value. Force unique timestamps via small sleeps.
    for (let i = 0; i < 6; i++) {
      const store = createSettingsStore({});
      store.set('maxBrowsers', i + 1);
      await save({
        store,
        catalog: testCatalog,
        configPath,
        agents,
        secretStore: makeSecretStore(),
      });
      // small async tick to ensure distinct timestamps
      await new Promise((r) => setTimeout(r, 5));
    }

    const backups = readdirSync(backupDir).filter((b) => b.startsWith('claude-code-'));
    expect(backups.length).toBe(5);
  });

  it('refuses to follow a symlinked agent config — surfaces failed[] with "refused: symlink"', async () => {
    // Real target file we don't want clobbered.
    const innocentBystander = join(tmp, 'bystander.json');
    writeFileSync(innocentBystander, JSON.stringify({ sensitive: 'data' }));
    // Symlink the agent config to it.
    symlinkSync(innocentBystander, agentAPath);

    const agents: AgentTarget[] = [
      makeAgent('claude-code', agentAPath, backupDir, ['mcpServers', 'wigolo']),
    ];

    const store = createSettingsStore({});
    store.set('browserTypes', 'chromium');

    const result = await save({
      store,
      catalog: testCatalog,
      configPath,
      agents,
      secretStore: makeSecretStore(),
    });

    expect(result.propagated).toEqual([]);
    expect(result.failed.map((f) => f.agentId)).toEqual(['claude-code']);
    expect(result.failed[0].reason).toMatch(/refused: symlink/);

    // Bystander file untouched.
    const bystander = JSON.parse(readFileSync(innocentBystander, 'utf-8'));
    expect(bystander).toEqual({ sensitive: 'data' });
  });

  it('refuses to follow a symlinked config.json — original symlink target untouched', async () => {
    const innocentBystander = join(tmp, 'bystander-config.json');
    const original = { sensitive: 'do not clobber' };
    writeFileSync(innocentBystander, JSON.stringify(original));
    symlinkSync(innocentBystander, configPath);

    const store = createSettingsStore({});
    store.set('browserTypes', 'chromium');

    const result = await save({
      store,
      catalog: testCatalog,
      configPath,
      agents: [],
      secretStore: makeSecretStore(),
    });

    expect(result.saved).toEqual([]);
    expect(result.errors?.some((e) => /refused: symlink/.test(e.reason))).toBe(true);

    // Symlink target unchanged.
    const after = JSON.parse(readFileSync(innocentBystander, 'utf-8'));
    expect(after).toEqual(original);
  });

  it('creates backup directory with 0o700 mode (owner-only)', async () => {
    if (process.platform === 'win32') return; // mode bits meaningless on Windows
    writeAgentConfig(agentAPath, ['mcpServers', 'wigolo'], { command: 'npx', args: ['wigolo'], env: {} });

    const agents: AgentTarget[] = [
      makeAgent('claude-code', agentAPath, backupDir, ['mcpServers', 'wigolo']),
    ];

    const store = createSettingsStore({});
    store.set('browserTypes', 'chromium');

    const result = await save({
      store,
      catalog: testCatalog,
      configPath,
      agents,
      secretStore: makeSecretStore(),
    });

    expect(result.propagated).toEqual(['claude-code']);
    expect(existsSync(backupDir)).toBe(true);
    const mode = statSync(backupDir).mode & 0o777;
    expect(mode).toBe(0o700);
  });
});
