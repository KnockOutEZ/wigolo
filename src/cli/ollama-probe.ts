// Lightweight, fail-safe reachability probe for a local Ollama server.
//
// Used by `doctor` and `init` to autodetect a running local LLM server and HINT
// (never silently enable) that it can power essay-grade research synthesis. The
// probe is deliberately defensive: a down / slow / absent server must NEVER
// throw, stall, or change the command's exit code — absence simply means no
// hint. It lives in cli/ (not in the merged slice-2 custom-backend module) per
// the slice boundary; it only IMPORTS the default base URL from there.

import { DEFAULT_OLLAMA_BASE_URL } from '../integrations/cloud/llm/custom-backend.js';

/** Short ceiling so the probe (and other CLI-side ollama fetches) never stall a command. */
export const DEFAULT_PROBE_TIMEOUT_MS = 400;

export interface OllamaProbeResult {
  reachable: boolean;
}

/**
 * Build the discoverability hint shown by doctor/init when a local LLM server
 * is reachable but no LLM is configured. Returns null (no hint) when an LLM is
 * already configured — discovery only, never a nag — or when no server answers.
 * Never auto-enables anything; it only tells the user the keyless lever exists.
 */
export function maybeOllamaHint(state: {
  reachable: boolean;
  llmConfigured: boolean;
  baseUrl: string;
}): string | null {
  if (!state.reachable || state.llmConfigured) return null;
  return `Local LLM server detected at ${state.baseUrl} — enable essay-grade research synthesis with \`WIGOLO_LLM_PROVIDER=ollama\` (no API key needed).`;
}

/**
 * Resolve the base URL the hint should probe + suggest. Env `WIGOLO_LLM_BASE_URL`
 * wins; otherwise the canonical local server. Mirrors slice-2's resolution order
 * for the env layer (config.json `llmBaseUrl` is folded in by callers via
 * getConfig().llmBaseUrl, which already layers env > config > default).
 */
export function resolveProbeBaseUrl(
  env: Record<string, string | undefined> = process.env,
): string {
  return env.WIGOLO_LLM_BASE_URL ?? DEFAULT_OLLAMA_BASE_URL;
}

/**
 * Probe `{baseUrl}/api/tags` with a short timeout. Returns `{ reachable }` and
 * NEVER throws — any error (connection refused, timeout, parse) resolves to
 * `reachable: false`. The AbortSignal guarantees the call cannot outlive
 * `timeoutMs`, so a hung server cannot stall the caller.
 *
 * `fetchImpl` is injected for testability; defaults to global fetch.
 */
export async function probeOllama(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<OllamaProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/api/tags`, {
      signal: controller.signal,
    });
    return { reachable: res.ok };
  } catch {
    return { reachable: false };
  } finally {
    clearTimeout(timer);
  }
}
