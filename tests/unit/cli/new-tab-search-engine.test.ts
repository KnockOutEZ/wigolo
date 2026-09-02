import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AppConfigWriteRefusedError,
  getConfig,
  InvalidNewTabSearchEngineError,
  resetConfig,
  setAppConfigSetting,
  validateNewTabSearchEngine,
} from '../../../src/config.js';
import { writePersistedConfig } from '../../../src/persisted-config.js';

describe('new-tab search engine config', () => {
  let scratchDir: string;
  let configPath: string;
  let previousConfigPath: string | undefined;
  let previousEngine: string | undefined;

  beforeEach(() => {
    scratchDir = mkdtempSync(join(tmpdir(), 'wigolo-new-tab-engine-'));
    configPath = join(scratchDir, 'config.json');
    previousConfigPath = process.env.WIGOLO_CONFIG_PATH;
    previousEngine = process.env.WIGOLO_NEW_TAB_SEARCH_ENGINE;
    process.env.WIGOLO_CONFIG_PATH = configPath;
    delete process.env.WIGOLO_NEW_TAB_SEARCH_ENGINE;
    resetConfig();
  });

  afterEach(() => {
    if (previousConfigPath === undefined) delete process.env.WIGOLO_CONFIG_PATH;
    else process.env.WIGOLO_CONFIG_PATH = previousConfigPath;
    if (previousEngine === undefined) delete process.env.WIGOLO_NEW_TAB_SEARCH_ENGINE;
    else process.env.WIGOLO_NEW_TAB_SEARCH_ENGINE = previousEngine;
    resetConfig();
    rmSync(scratchDir, { recursive: true, force: true });
  });

  it('resolves env over persisted config over the google default', () => {
    expect(getConfig().newTabSearchEngine).toBe('google');

    writePersistedConfig(configPath, { settings: { newTabSearchEngine: 'duckduckgo' } });
    resetConfig();
    expect(getConfig().newTabSearchEngine).toBe('duckduckgo');

    process.env.WIGOLO_NEW_TAB_SEARCH_ENGINE = 'bing';
    resetConfig();
    expect(getConfig().newTabSearchEngine).toBe('bing');
  });

  it('persists a valid human app write and preserves sibling settings', () => {
    const template = 'https://search.example.test/?q={searchTerms}' as const;
    writePersistedConfig(configPath, { settings: { searchBackend: 'core' } });

    expect(setAppConfigSetting('newTabSearchEngine', template, 'human', configPath)).toBe(template);
    const persisted = JSON.parse(readFileSync(configPath, 'utf8')) as {
      settings: Record<string, unknown>;
    };
    expect(persisted.settings).toMatchObject({
      searchBackend: 'core',
      newTabSearchEngine: template,
    });
    expect(getConfig().newTabSearchEngine).toBe(template);
  });

  it('refuses invalid templates with a typed reason and never stores them', () => {
    writePersistedConfig(configPath, { settings: { newTabSearchEngine: 'google' } });

    expect(() =>
      setAppConfigSetting(
        'newTabSearchEngine',
        'http://search.example.test/?q={searchTerms}',
        'human',
        configPath,
      ),
    ).toThrowError(
      expect.objectContaining<Partial<InvalidNewTabSearchEngineError>>({
        reason: 'template_not_absolute_https',
      }),
    );
    expect(JSON.parse(readFileSync(configPath, 'utf8')).settings.newTabSearchEngine).toBe('google');
  });

  it('refuses non-allowlisted keys before writing', () => {
    writePersistedConfig(configPath, { settings: { searchBackend: 'core' } });

    expect(() => setAppConfigSetting('searchBackend', 'hybrid', 'human', configPath)).toThrowError(
      expect.objectContaining<Partial<AppConfigWriteRefusedError>>({
        reason: 'key_not_allowlisted',
      }),
    );
    expect(JSON.parse(readFileSync(configPath, 'utf8')).settings).toEqual({ searchBackend: 'core' });
  });

  it('refuses non-human writers before writing', () => {
    writePersistedConfig(configPath, { settings: { newTabSearchEngine: 'google' } });

    expect(() =>
      setAppConfigSetting('newTabSearchEngine', 'bing', 'agent', configPath),
    ).toThrowError(
      expect.objectContaining<Partial<AppConfigWriteRefusedError>>({
        reason: 'writer_not_allowed',
      }),
    );
    expect(JSON.parse(readFileSync(configPath, 'utf8')).settings.newTabSearchEngine).toBe('google');
  });

  it('reports typed validation reasons for unsupported and incomplete values', () => {
    expect(validateNewTabSearchEngine('yahoo')).toMatchObject({
      valid: false,
      reason: 'unsupported_preset',
    });
    expect(validateNewTabSearchEngine('https://search.example.test/')).toMatchObject({
      valid: false,
      reason: 'template_missing_search_terms',
    });
  });

  it('refuses invalid values from env or persisted config', () => {
    writePersistedConfig(configPath, { settings: { newTabSearchEngine: 'yahoo' } });
    resetConfig();
    expect(() => getConfig()).toThrowError(
      expect.objectContaining<Partial<InvalidNewTabSearchEngineError>>({ reason: 'unsupported_preset' }),
    );

    process.env.WIGOLO_NEW_TAB_SEARCH_ENGINE = 'http://search.test/?q={searchTerms}';
    resetConfig();
    expect(() => getConfig()).toThrowError(
      expect.objectContaining<Partial<InvalidNewTabSearchEngineError>>({
        reason: 'template_not_absolute_https',
      }),
    );
  });
});
