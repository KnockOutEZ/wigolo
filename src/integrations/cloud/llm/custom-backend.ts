// Resolves an OpenAI-compatible "custom" LLM backend from configuration.
//
// Two shapes map to the same custom code path in run.ts (no API key needed):
//   - an explicit OpenAI-compatible base URL (http(s)://...) — vLLM, LM Studio,
//     a remote proxy, or Ollama via its raw URL.
//   - the literal alias `ollama` — resolves to a local Ollama base
//     (http://localhost:11434, overridable via WIGOLO_LLM_BASE_URL) and flags
//     isOllama so the runner can auto-pick an installed model from /api/tags.
//
// The alias may come from WIGOLO_LLM_PROVIDER env OR persisted config.json
// (`llmProvider: "ollama"`), so a `wigolo init`-chosen runtime with zero env
// vars still routes to the local server.

import { readPersistedConfig, defaultConfigPath } from '../../../persisted-config.js';

/** Default base URL for the local Ollama server (OpenAI-compat endpoint lives under /v1). */
export const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434';

export interface CustomBackend {
  /** Base URL (no trailing /v1/chat/completions — run.ts normalizes that). */
  url: string;
  /** True when this resolved from the `ollama` alias (enables model auto-pick). */
  isOllama: boolean;
}

function isHttpUrl(raw: string): boolean {
  return raw.startsWith('http://') || raw.startsWith('https://');
}

/**
 * Read the persisted `llmProvider` from config.json (no env layer). Mirrors
 * select.ts's reader so the alias is honored when chosen during `wigolo init`.
 */
function persistedLlmProvider(): string | null {
  const { settings } = readPersistedConfig(defaultConfigPath());
  const v = settings.llmProvider;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Read persisted `llmBaseUrl` from config.json (no env layer). */
function persistedLlmBaseUrl(): string | null {
  const { settings } = readPersistedConfig(defaultConfigPath());
  const v = settings.llmBaseUrl;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Resolve the Ollama base URL: WIGOLO_LLM_BASE_URL env > persisted config.json
 * `llmBaseUrl` > the default local server. So a zero-env runtime configured via
 * `wigolo init` still honors a custom base.
 */
function resolveOllamaBaseUrl(env: Record<string, string | undefined>): string {
  return env.WIGOLO_LLM_BASE_URL ?? persistedLlmBaseUrl() ?? DEFAULT_OLLAMA_BASE_URL;
}

/**
 * Resolve a custom (keyless, OpenAI-compatible) LLM backend from env + persisted
 * config, or null when none applies (a cloud provider or nothing is configured).
 *
 *   - http(s):// URL in WIGOLO_LLM_PROVIDER → { url, isOllama: false }
 *   - `ollama` in WIGOLO_LLM_PROVIDER or config.json llmProvider
 *       → { url: WIGOLO_LLM_BASE_URL ?? http://localhost:11434, isOllama: true }
 *   - anything else (provider id, unset) → null
 *
 * Env wins over persisted config: a URL or cloud-provider id in
 * WIGOLO_LLM_PROVIDER is authoritative and short-circuits the config.json check.
 */
export function resolveCustomBackend(
  env: Record<string, string | undefined> = process.env,
): CustomBackend | null {
  const raw = env.WIGOLO_LLM_PROVIDER;

  if (raw) {
    if (isHttpUrl(raw)) return { url: raw, isOllama: false };
    if (raw === 'ollama') {
      return { url: resolveOllamaBaseUrl(env), isOllama: true };
    }
    // Env names a cloud provider id (or junk) — not a custom backend. Do NOT
    // fall through to config.json: an explicit env override is authoritative.
    return null;
  }

  // No env override — honor persisted config.json `llmProvider: "ollama"`.
  if (persistedLlmProvider() === 'ollama') {
    return { url: resolveOllamaBaseUrl(env), isOllama: true };
  }

  return null;
}

/**
 * Synthesis models known to produce decent prose, highest priority first. The
 * runner picks the first installed prefix match from /api/tags before falling
 * back to the first installed model, then to RECOMMENDED_OLLAMA_MODEL.
 */
export const OLLAMA_MODEL_PRIORITY: readonly string[] = [
  'llama3.1',
  'qwen2.5',
  'mistral',
  'gemma2',
  'phi3',
  'llama3',
];

/** Fallback model name when /api/tags is unreachable or returns nothing. */
export const RECOMMENDED_OLLAMA_MODEL = 'llama3.1';

/**
 * Pick an Ollama model for synthesis from the running server's installed list.
 *   1. first installed model whose name starts with a priority prefix
 *   2. else the first installed model
 *   3. else (tags query fails / empty) the recommended fallback name
 *
 * `fetchImpl` is injected for testability; defaults to global fetch.
 */
export async function pickOllamaModel(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<string> {
  let installed: string[] = [];
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/api/tags`, { signal });
    if (res.ok) {
      const payload = (await res.json()) as { models?: Array<{ name?: unknown }> };
      installed = (payload.models ?? [])
        .map((m) => (typeof m.name === 'string' ? m.name : ''))
        .filter((n) => n.length > 0);
    }
  } catch {
    // Unreachable / parse error — fall through to the recommended name.
  }

  if (installed.length === 0) return RECOMMENDED_OLLAMA_MODEL;

  for (const prefix of OLLAMA_MODEL_PRIORITY) {
    const match = installed.find((name) => name.startsWith(prefix));
    if (match) return match;
  }

  return installed[0];
}
