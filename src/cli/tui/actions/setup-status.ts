import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

// This project is pure ESM (`"type":"module"`); `require` is not defined at
// runtime. Use createRequire so the synchronous probe body can lazily load
// modules without making defaultProbeDeps async. Mirrors src/security/keychain.ts.
const require = createRequire(import.meta.url);

export type ComponentState = 'ok' | 'failed' | 'degraded' | 'absent';

export interface ComponentStatus {
  id: string;
  label: string;
  required: boolean;
  status: ComponentState;
  detail?: string;       // error / reason
  disables?: string;     // capability lost when not ok (e.g. "find_similar")
}

export interface SetupSummary {
  lines: string[];
  readyCount: number;
  total: number;
  requiredFailed: boolean;
  exitCode: 0 | 1;
}

export function glyph(s: ComponentState): string {
  if (s === 'ok') return '✓';
  if (s === 'absent') return '⚠';
  if (s === 'degraded') return '⚠';
  return '✗';
}

export function summarizeSetup(components: ComponentStatus[]): SetupSummary {
  const total = components.length;
  const readyCount = components.filter(c => c.status === 'ok').length;
  const requiredFailed = components.some(c => c.required && c.status !== 'ok');

  const lines: string[] = [`Setup: ${readyCount}/${total} ready`];
  for (const c of components) {
    let line = `  ${glyph(c.status)} ${c.label}`;
    if (c.detail && c.status !== 'ok') line += ` — ${c.detail}`;
    if (c.disables && c.status !== 'ok') line += `   → ${c.disables} disabled`;
    if (c.status === 'absent' && !c.required) line += ' (optional)';
    lines.push(line);
  }
  lines.push('Run `wigolo doctor` for detail. Re-run setup: `wigolo init`.');

  return { lines, readyCount, total, requiredFailed, exitCode: requiredFailed ? 1 : 0 };
}

/**
 * True when the persisted config references a stored LLM key — WITHOUT reading
 * the secret itself. A key is referenced by a `<field>KeyLocation` pointer (see
 * propagation.ts); the raw value is never written to config. Recognizing that
 * pointer is what keeps the honest summary from falsely reporting "LLM key
 * absent" on every env-less probe after a key was persisted on a prior run.
 */
export function configReferencesLlmKey(cfg: {
  provider?: { keyLocation?: unknown };
  settings: Record<string, unknown>;
}): boolean {
  if (cfg.provider?.keyLocation) return true;
  const keyLocation = cfg.settings['llmApiKeyKeyLocation'];
  if (typeof keyLocation === 'string' && keyLocation.length > 0) return true;
  // Legacy/alt: a non-empty llmApiKey reference stored directly under settings.
  const llmApiKey = cfg.settings['llmApiKey'];
  if (typeof llmApiKey === 'string' && llmApiKey.length > 0) return true;
  return false;
}

// ---------------------------------------------------------------------------
// probeSetupStatus — injectable deps for unit-testability
// ---------------------------------------------------------------------------

export interface ProbeDeps {
  browserInstalled: () => boolean;
  searchBackend: () => 'core' | 'searxng' | 'hybrid';
  searxngReady: () => boolean;
  embeddingsInstalled: () => boolean;
  rerankerInstalled: () => boolean;
  llmKeyPresent: () => boolean;
  configuredAgents: () => readonly string[];
}

export async function probeSetupStatus(deps: ProbeDeps): Promise<ComponentStatus[]> {
  const backend = deps.searchBackend();
  const agents = deps.configuredAgents();

  // core backend needs no native engine; searxng/hybrid degrade (not fail) when engine not ready
  const searchOk = backend === 'core' ? true : deps.searxngReady();
  const searchStatus: ComponentState = backend === 'core' ? 'ok' : (searchOk ? 'ok' : 'degraded');

  return [
    {
      id: 'browser',
      label: 'browser',
      required: true,
      status: deps.browserInstalled() ? 'ok' : 'failed',
      detail: deps.browserInstalled() ? undefined : 'browser engine not installed',
    },
    {
      id: 'agents',
      label: `agents(${agents.join(',') || 'none'})`,
      required: true,
      status: agents.length > 0 ? 'ok' : 'failed',
      detail: agents.length > 0 ? undefined : 'no agent configured',
    },
    {
      id: 'search',
      label: `search(${backend})`,
      required: false,
      status: searchStatus,
      detail: searchStatus === 'degraded' ? 'search engine not ready — falls back to core' : undefined,
    },
    {
      id: 'embeddings',
      label: 'embeddings',
      required: false,
      status: deps.embeddingsInstalled() ? 'ok' : 'failed',
      disables: 'find_similar',
    },
    {
      id: 'reranker',
      label: 'ML reranker',
      required: false,
      status: deps.rerankerInstalled() ? 'ok' : 'degraded',
      detail: deps.rerankerInstalled() ? undefined : 'relevance reranking off',
    },
    {
      id: 'llm',
      label: 'LLM key',
      required: false,
      status: deps.llmKeyPresent() ? 'ok' : 'absent',
      disables: 'research/agent',
    },
  ];
}

// ---------------------------------------------------------------------------
// defaultProbeDeps — wires to real on-disk/env state (no model loads)
// ---------------------------------------------------------------------------

function dirNonEmpty(dirPath: string): boolean {
  if (!existsSync(dirPath)) return false;
  try {
    return readdirSync(dirPath).length > 0;
  } catch {
    return false;
  }
}

export function defaultProbeDeps(): ProbeDeps {
  return {
    browserInstalled(): boolean {
      try {
        // Dynamic require so this module is importable in environments where
        // playwright is not installed (e.g. minimal CI workers).
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { chromium } = require('playwright');
        const execPath: string = chromium.executablePath();
        return existsSync(execPath);
      } catch {
        return false;
      }
    },

    searchBackend(): 'core' | 'searxng' | 'hybrid' {
      // Read from persisted config first, then fall back to env, then default 'core'.
      try {
        const { readPersistedConfig, defaultConfigPath } = require('../../../persisted-config.js') as typeof import('../../../persisted-config.js');
        const cfg = readPersistedConfig(defaultConfigPath());
        const persisted = cfg.settings['searchBackend'];
        if (persisted === 'core' || persisted === 'searxng' || persisted === 'hybrid') {
          return persisted;
        }
      } catch {
        // fall through
      }
      const raw = process.env.WIGOLO_SEARCH;
      if (raw === 'searxng' || raw === 'hybrid') return raw;
      return 'core';
    },

    searxngReady(): boolean {
      try {
        const { getConfig } = require('../../../config.js') as typeof import('../../../config.js');
        const { getBootstrapState } = require('../../../searxng/bootstrap.js') as typeof import('../../../searxng/bootstrap.js');
        const state = getBootstrapState(getConfig().dataDir);
        return state?.status === 'ready';
      } catch {
        return false;
      }
    },

    embeddingsInstalled(): boolean {
      try {
        const { getConfig } = require('../../../config.js') as typeof import('../../../config.js');
        return dirNonEmpty(join(getConfig().dataDir, 'fastembed'));
      } catch {
        return false;
      }
    },

    rerankerInstalled(): boolean {
      try {
        const { getConfig } = require('../../../config.js') as typeof import('../../../config.js');
        return dirNonEmpty(join(getConfig().dataDir, 'transformers'));
      } catch {
        return false;
      }
    },

    configuredAgents(): readonly string[] {
      try {
        const { getConfig } = require('../../../config.js') as typeof import('../../../config.js');
        const { readInitConfig } = require('../../tui/utils/config-writer.js') as typeof import('../../tui/utils/config-writer.js');
        const settings = readInitConfig(getConfig().dataDir);
        const agents = settings['configuredAgents'];
        if (Array.isArray(agents)) return agents as string[];
      } catch {
        // fall through
      }
      return [];
    },

    llmKeyPresent(): boolean {
      if (process.env.WIGOLO_LLM_API_KEY) return true;
      // Check the persisted config for a key reference (without reading the secret).
      try {
        const { readPersistedConfig, defaultConfigPath } = require('../../../persisted-config.js') as typeof import('../../../persisted-config.js');
        return configReferencesLlmKey(readPersistedConfig(defaultConfigPath()));
      } catch {
        return false;
      }
    },
  };
}
