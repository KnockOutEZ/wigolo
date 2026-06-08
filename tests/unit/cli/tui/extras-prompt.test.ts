import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('@inquirer/prompts', () => ({
  select: vi.fn(),
  input: vi.fn(),
  password: vi.fn(),
}));

const storeKeyMock = vi.fn();
vi.mock('../../../../src/security/key-store.js', () => ({
  storeKey: storeKeyMock,
}));

import { select, input, password } from '@inquirer/prompts';
import { promptExtras } from '../../../../src/cli/tui/extras-prompt.js';

const selectMock = vi.mocked(select);
const inputMock = vi.mocked(input);
const passwordMock = vi.mocked(password);

describe('promptExtras', () => {
  let dir: string;

  beforeEach(() => {
    selectMock.mockReset();
    inputMock.mockReset();
    passwordMock.mockReset();
    storeKeyMock.mockReset().mockResolvedValue({ location: 'keychain' });
    dir = mkdtempSync(join(tmpdir(), 'wigolo-extras-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // Default happy-path mocks: skip engine, blank rss, blank llm endpoint,
  // skip provider (the new B4 prompt). Tests that exercise the provider prompt
  // override the relevant mock(s).
  function mockSkipAll(): void {
    selectMock.mockResolvedValueOnce('skip'); // engine
    inputMock.mockResolvedValueOnce(''); // rss
    inputMock.mockResolvedValueOnce(''); // llm endpoint
    selectMock.mockResolvedValueOnce('skip'); // provider
  }

  it('returns empty + writes nothing when user picks skip + blanks', async () => {
    mockSkipAll();

    const result = await promptExtras(dir);
    expect(result).toEqual({});
    expect(existsSync(join(dir, 'config.json'))).toBe(false);
    expect(passwordMock).not.toHaveBeenCalled();
    expect(storeKeyMock).not.toHaveBeenCalled();
  });

  it('persists engine selection only when not skip', async () => {
    selectMock.mockResolvedValueOnce('v1');
    inputMock.mockResolvedValueOnce('');
    inputMock.mockResolvedValueOnce('');
    selectMock.mockResolvedValueOnce('skip'); // provider

    const result = await promptExtras(dir);
    expect(result.engine).toBe('v1');
    // SP0 introduced a versioned envelope: { version: 1, settings: { ... } }.
    // The runtime reader surfaces settings.* via readPersistedConfig().settings.
    const cfg = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf-8'));
    expect(cfg.settings.engine).toBe('v1');
  });

  it('parses comma-separated RSS feeds and persists as array', async () => {
    selectMock.mockResolvedValueOnce('skip');
    inputMock.mockResolvedValueOnce(' https://a.example/feed , https://b.example/feed ,');
    inputMock.mockResolvedValueOnce('');
    selectMock.mockResolvedValueOnce('skip'); // provider

    const result = await promptExtras(dir);
    expect(result.rssFeeds).toEqual([
      'https://a.example/feed',
      'https://b.example/feed',
    ]);
    // SP0: values live under the versioned envelope's settings map on disk.
    const cfg = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf-8'));
    expect(cfg.settings.rssFeeds).toEqual(['https://a.example/feed', 'https://b.example/feed']);
  });

  it('persists llmEndpoint when non-blank', async () => {
    selectMock.mockResolvedValueOnce('skip');
    inputMock.mockResolvedValueOnce('');
    inputMock.mockResolvedValueOnce('http://localhost:11434/v1');
    selectMock.mockResolvedValueOnce('skip'); // provider

    const result = await promptExtras(dir);
    expect(result.llmEndpoint).toBe('http://localhost:11434/v1');
  });

  it('treats Ctrl-C / ExitPromptError as skip-all', async () => {
    selectMock.mockRejectedValueOnce(new Error('User force closed the prompt with 0 null'));

    const result = await promptExtras(dir);
    expect(result).toEqual({});
  });

  it('preserves other fields in config.json (merge semantics)', async () => {
    const cfgPath = join(dir, 'config.json');
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(dir, { recursive: true });
    // Write a legacy version-less flat config; migration lifts it into settings.*.
    writeFileSync(cfgPath, JSON.stringify({ configuredAgents: ['claude-code'] }));

    selectMock.mockResolvedValueOnce('v1');
    inputMock.mockResolvedValueOnce('');
    inputMock.mockResolvedValueOnce('');
    selectMock.mockResolvedValueOnce('skip'); // provider

    await promptExtras(dir);
    // SP0: the versioned envelope nests everything under settings.  The migration
    // path (legacy file has no `version`) lifts pre-existing flat keys into
    // settings.* so no data is lost.  Runtime reads via readPersistedConfig().settings.
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    expect(cfg.settings.configuredAgents).toEqual(['claude-code']);
    expect(cfg.settings.engine).toBe('v1');
  });

  describe('interactive LLM provider + key prompt (B4)', () => {
    it('persists chosen provider to config.json and stores key in keychain', async () => {
      selectMock.mockResolvedValueOnce('skip'); // engine
      inputMock.mockResolvedValueOnce(''); // rss
      inputMock.mockResolvedValueOnce(''); // llm endpoint
      selectMock.mockResolvedValueOnce('anthropic'); // provider
      passwordMock.mockResolvedValueOnce('sk-interactive-key'); // key

      const result = await promptExtras(dir);

      expect(result.llmProvider).toBe('anthropic');
      const cfg = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf-8'));
      expect(cfg.settings.llmProvider).toBe('anthropic');
      expect(storeKeyMock).toHaveBeenCalledWith(
        'anthropic',
        'sk-interactive-key',
        expect.objectContaining({ dataDir: dir }),
      );
    });

    it('NEVER writes the API key value to config.json', async () => {
      selectMock.mockResolvedValueOnce('skip');
      inputMock.mockResolvedValueOnce('');
      inputMock.mockResolvedValueOnce('');
      selectMock.mockResolvedValueOnce('openai');
      passwordMock.mockResolvedValueOnce('sk-secret-should-not-leak');

      await promptExtras(dir);

      const raw = readFileSync(join(dir, 'config.json'), 'utf-8');
      expect(raw).not.toContain('sk-secret-should-not-leak');
      const cfg = JSON.parse(raw);
      expect(cfg.settings.llmApiKey).toBeUndefined();
      expect(cfg.settings.llmProvider).toBe('openai');
    });

    it('skips provider prompt entirely → no key prompt, no storeKey, no provider in config', async () => {
      selectMock.mockResolvedValueOnce('skip'); // engine
      inputMock.mockResolvedValueOnce(''); // rss
      inputMock.mockResolvedValueOnce(''); // llm endpoint
      selectMock.mockResolvedValueOnce('skip'); // provider skip

      const result = await promptExtras(dir);

      expect(result.llmProvider).toBeUndefined();
      expect(passwordMock).not.toHaveBeenCalled();
      expect(storeKeyMock).not.toHaveBeenCalled();
    });

    it('provider chosen but blank key → persists provider, does not call storeKey', async () => {
      selectMock.mockResolvedValueOnce('skip');
      inputMock.mockResolvedValueOnce('');
      inputMock.mockResolvedValueOnce('');
      selectMock.mockResolvedValueOnce('gemini'); // provider
      passwordMock.mockResolvedValueOnce(''); // blank key

      const result = await promptExtras(dir);

      expect(result.llmProvider).toBe('gemini');
      const cfg = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf-8'));
      expect(cfg.settings.llmProvider).toBe('gemini');
      expect(storeKeyMock).not.toHaveBeenCalled();
    });
  });
});
