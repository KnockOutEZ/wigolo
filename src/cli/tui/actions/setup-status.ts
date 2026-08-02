import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

// This project is pure ESM (`"type":"module"`); `require` is not defined at
// runtime. Use createRequire so the synchronous probe body can lazily load
// modules without making defaultProbeDeps async. Mirrors src/security/keychain.ts.
const require = createRequire(import.meta.url);

// 'lazy'    — component acquired on first use (P0 lazy acquisition); not a
//             failure, and not yet present. Renders ○ with a warmup hint.
// 'skipped' — deliberately not set up (e.g. engine-only mode registers no
//             agent); not a failure and not required.
export type ComponentState = 'ok' | 'failed' | 'degraded' | 'absent' | 'lazy' | 'skipped';

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
  // A lazily-acquired or deliberately-skipped component is not a failure — a
  // ✗ would read as broken. ○ marks "not present, but not a problem".
  if (s === 'lazy' || s === 'skipped') return '○';
  return '✗';
}

export function summarizeSetup(components: ComponentStatus[]): SetupSummary {
  const total = components.length;
  const readyCount = components.filter(c => c.status === 'ok').length;
  // 'lazy' / 'skipped' are non-failure states even for a required component:
  // a required-but-lazy component (P0 lazy acquisition) will be there on first
  // use, so it must not fail the setup and must not flip the exit code.
  const requiredFailed = components.some(
    c => c.required && c.status !== 'ok' && c.status !== 'lazy' && c.status !== 'skipped',
  );

  const lines: string[] = [`Setup: ${readyCount}/${total} ready`];
  for (const c of components) {
    let line = `  ${glyph(c.status)} ${c.label}`;
    // Detail is informative for lazy/skipped too (names the warmup flag / mode),
    // so show it for any non-ok state that carries one.
    if (c.detail && c.status !== 'ok') line += ` — ${c.detail}`;
    // A lazy/skipped capability is not lost — it just isn't cached yet — so do
    // NOT print the "→ X disabled" suffix for those states.
    if (c.disables && c.status !== 'ok' && c.status !== 'lazy' && c.status !== 'skipped') {
      line += `   → ${c.disables} disabled`;
    }
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

export interface ProbeOptions {
  /**
   * Whether agent registration was requested/expected — true when the user
   * gave `--agents=<...>` or went through the interactive agent-selection step.
   * When false, this is engine-only mode: no agent is registered on purpose, so
   * the agents component is neither required nor a failure. Defaults to true so
   * a caller that omits it never silently drops the "agent failed to register"
   * guard (case b): agents requested but registration failed still fails setup.
   */
  agentsRequested?: boolean;
}

export async function probeSetupStatus(
  deps: ProbeDeps,
  options: ProbeOptions = {},
): Promise<ComponentStatus[]> {
  const backend = deps.searchBackend();
  const agents = deps.configuredAgents();
  const agentsRequested = options.agentsRequested ?? true;

  // core backend needs no native engine; searxng/hybrid degrade (not fail) when engine not ready
  const searchOk = backend === 'core' ? true : deps.searxngReady();
  const searchStatus: ComponentState = backend === 'core' ? 'ok' : (searchOk ? 'ok' : 'degraded');

  // Agents component:
  //  - registration requested + configured → ok
  //  - registration requested + none present → failed (the guard must not go
  //    vacuous: a requested-but-failed registration is a real setup failure)
  //  - engine-only mode (not requested) → skipped, not required, not a failure.
  //    wigolo works for any MCP client, so setting up the engine alone is valid.
  const agentsStatus: ComponentState = agents.length > 0
    ? 'ok'
    : agentsRequested ? 'failed' : 'skipped';
  const agentsDetail = agents.length > 0
    ? undefined
    : agentsRequested
      ? 'no agent configured'
      : 'engine-only — point your MCP client at `npx wigolo mcp`';

  return [
    {
      id: 'browser',
      label: 'browser',
      // Still required for operation, but lazily acquired: a missing browser
      // triggers a background install on first fetch use (browser-acquire), so
      // absence at init time is 'lazy', not a setup failure.
      required: true,
      status: deps.browserInstalled() ? 'ok' : 'lazy',
      detail: deps.browserInstalled()
        ? undefined
        : 'downloads on first use — `wigolo warmup --browser` pre-caches',
    },
    {
      id: 'agents',
      label: `agents(${agents.join(',') || 'none'})`,
      required: agents.length > 0 ? true : agentsRequested,
      status: agentsStatus,
      detail: agentsDetail,
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
      status: deps.embeddingsInstalled() ? 'ok' : 'lazy',
      detail: deps.embeddingsInstalled()
        ? undefined
        : 'downloads on first use — `wigolo warmup --embeddings` pre-caches',
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
