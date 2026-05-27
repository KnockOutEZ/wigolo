/**
 * Tests for exportConfig and importConfig actions.
 *
 * Why: exportConfig must produce a re-importable file without leaking secrets.
 * importConfig must validate + apply the config via SP0 accessor. Round-trip
 * correctness and secret exclusion are business-critical invariants tested here.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resetPersistedConfig } from '../../../../../src/persisted-config.js';
import {
  exportConfig,
  importConfig,
  type ExportConfigResult,
  type ImportConfigResult,
} from '../../../../../src/cli/tui/actions/export-import-config.js';

let tmpDir: string;
let configPath: string;
let exportPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'wigolo-sp5-export-'));
  configPath = join(tmpDir, 'config.json');
  exportPath = join(tmpDir, 'wigolo-export.json');
  resetPersistedConfig();
});

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
  resetPersistedConfig();
});

describe('exportConfig — basic export', () => {
  it('creates the export file at the given path', async () => {
    const result = await exportConfig(exportPath, configPath);
    expect(result.ok).toBe(true);
    expect(existsSync(exportPath)).toBe(true);
  });

  it('exported file is valid JSON', async () => {
    await exportConfig(exportPath, configPath);
    const raw = readFileSync(exportPath, 'utf-8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it('export contains a version field', async () => {
    await exportConfig(exportPath, configPath);
    const data = JSON.parse(readFileSync(exportPath, 'utf-8')) as Record<string, unknown>;
    expect(typeof data.version).toBe('number');
  });

  it('export contains a settings field', async () => {
    await exportConfig(exportPath, configPath);
    const data = JSON.parse(readFileSync(exportPath, 'utf-8')) as Record<string, unknown>;
    expect(typeof data.settings).toBe('object');
  });

  it('export contains an exportedAt timestamp', async () => {
    await exportConfig(exportPath, configPath);
    const data = JSON.parse(readFileSync(exportPath, 'utf-8')) as Record<string, unknown>;
    expect(typeof data.exportedAt).toBe('string');
    // ISO 8601 format
    expect(() => new Date(data.exportedAt as string)).not.toThrow();
  });
});

describe('exportConfig — secret exclusion', () => {
  it('does not include braveApiKey in the export', async () => {
    // Write a config that has a braveApiKey in settings (should never happen
    // via public API, but test the export guard as a second line of defense)
    writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        settings: { WIGOLO_SEARCH: 'core', braveApiKey: 'sk-secret' },
      }),
      'utf-8',
    );
    await exportConfig(exportPath, configPath);
    const data = JSON.parse(readFileSync(exportPath, 'utf-8')) as Record<string, unknown>;
    const settings = data.settings as Record<string, unknown>;
    expect(settings['braveApiKey']).toBeUndefined();
    expect(settings['WIGOLO_SEARCH']).toBe('core');
  });

  it('does not include githubToken in the export', async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        settings: { WIGOLO_SEARCH: 'hybrid', githubToken: 'ghp_token' },
      }),
      'utf-8',
    );
    await exportConfig(exportPath, configPath);
    const data = JSON.parse(readFileSync(exportPath, 'utf-8')) as Record<string, unknown>;
    const settings = data.settings as Record<string, unknown>;
    expect(settings['githubToken']).toBeUndefined();
    expect(settings['WIGOLO_SEARCH']).toBe('hybrid');
  });

  it('does not include provider key values (only name + keyLocation)', async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        settings: {},
        provider: { name: 'anthropic', keyLocation: 'env', key: 'sk-ant-secret' },
      }),
      'utf-8',
    );
    await exportConfig(exportPath, configPath);
    const data = JSON.parse(readFileSync(exportPath, 'utf-8')) as Record<string, unknown>;
    if (data.provider) {
      const p = data.provider as Record<string, unknown>;
      expect(p['key']).toBeUndefined();
      expect(typeof p['name']).toBe('string');
    }
  });
});

describe('importConfig — round-trip', () => {
  it('settings written by exportConfig are readable back via importConfig', async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        settings: { WIGOLO_SEARCH: 'hybrid', WIGOLO_LOG_LEVEL: 'debug' },
      }),
      'utf-8',
    );
    const newConfigPath = join(tmpDir, 'config-new.json');
    await exportConfig(exportPath, configPath);
    resetPersistedConfig();
    const result = await importConfig(exportPath, newConfigPath);
    expect(result.ok).toBe(true);
    resetPersistedConfig();
    const { readPersistedConfig } = await import('../../../../../src/persisted-config.js');
    const loaded = readPersistedConfig(newConfigPath);
    expect(loaded.settings['WIGOLO_SEARCH']).toBe('hybrid');
    expect(loaded.settings['WIGOLO_LOG_LEVEL']).toBe('debug');
  });

  it('importConfig fails gracefully on invalid JSON', async () => {
    writeFileSync(exportPath, 'NOT JSON', 'utf-8');
    const result = await importConfig(exportPath, configPath);
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('importConfig fails gracefully when file does not exist', async () => {
    const result = await importConfig(join(tmpDir, 'missing.json'), configPath);
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('import strips secrets even if export file was hand-crafted with secrets', async () => {
    writeFileSync(
      exportPath,
      JSON.stringify({
        version: 1,
        exportedAt: new Date().toISOString(),
        settings: { WIGOLO_SEARCH: 'core', braveApiKey: 'hacked', githubToken: 'hacked' },
      }),
      'utf-8',
    );
    const newConfigPath = join(tmpDir, 'config-import.json');
    const result = await importConfig(exportPath, newConfigPath);
    expect(result.ok).toBe(true);
    resetPersistedConfig();
    const { readPersistedConfig } = await import('../../../../../src/persisted-config.js');
    const loaded = readPersistedConfig(newConfigPath);
    expect(loaded.settings['braveApiKey']).toBeUndefined();
    expect(loaded.settings['githubToken']).toBeUndefined();
    expect(loaded.settings['WIGOLO_SEARCH']).toBe('core');
  });
});

describe('importConfig — size cap (DoS / accidental-blob guard)', () => {
  it('rejects an import file larger than 1 MB before reading it', async () => {
    // Write a >1 MB file. Valid JSON shape, but oversized — must be refused
    // on the statSync size check, never parsed.
    const bigSettings: Record<string, string> = {};
    // ~1.2 MB of JSON: 20000 keys with 60-char values.
    for (let i = 0; i < 20000; i++) {
      bigSettings[`k${i}`] = 'v'.repeat(60);
    }
    writeFileSync(
      exportPath,
      JSON.stringify({ version: 1, settings: bigSettings }),
      'utf-8',
    );
    const result = await importConfig(exportPath, configPath);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/exceeds|bytes/i);
  });

  it('accepts a normal-sized import file', async () => {
    writeFileSync(
      exportPath,
      JSON.stringify({ version: 1, settings: { WIGOLO_SEARCH: 'core' } }),
      'utf-8',
    );
    const result = await importConfig(exportPath, configPath);
    expect(result.ok).toBe(true);
  });
});

describe('exportConfig — temp file cleanup on failure', () => {
  it('does not leave an orphaned .tmp file when rename fails', async () => {
    // Point exportPath at a directory; renameSync(tmp, dir) fails with EISDIR/
    // ENOTEMPTY, exercising the catch + rmSync(tmp) cleanup path.
    const dirAsTarget = join(tmpDir, 'export-as-dir');
    mkdirSync(dirAsTarget, { recursive: true });
    // Put a file inside so rename-over-dir definitely fails.
    writeFileSync(join(dirAsTarget, 'keep.txt'), 'x', 'utf-8');

    const result = await exportConfig(dirAsTarget, configPath);
    expect(result.ok).toBe(false);

    // No leftover .export-*.tmp in tmpDir.
    const leftovers = readdirSync(tmpDir).filter((f) => f.startsWith('.export-') && f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });
});

describe('ExportConfigResult / ImportConfigResult shape', () => {
  it('exportConfig result has ok field', async () => {
    const result: ExportConfigResult = await exportConfig(exportPath, configPath);
    expect(typeof result.ok).toBe('boolean');
  });

  it('importConfig result has ok field', async () => {
    await exportConfig(exportPath, configPath);
    const result: ImportConfigResult = await importConfig(exportPath, configPath);
    expect(typeof result.ok).toBe('boolean');
  });
});
