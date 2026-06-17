import type { LLMProvider } from './types.js';
import type { KeyStoreOpts } from '../../../security/key-store.js';
import { readPersistedConfig, defaultConfigPath } from '../../../persisted-config.js';
import { resolveCustomBackend } from './custom-backend.js';

const PROVIDER_ORDER: LLMProvider[] = ['anthropic', 'openai', 'gemini', 'groq'];

const PROVIDER_ENV: Record<LLMProvider, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GOOGLE_API_KEY',
  groq: 'GROQ_API_KEY',
};

export function selectProvider(
  env: Record<string, string | undefined>,
): LLMProvider | null {
  const override = env.WIGOLO_LLM_PROVIDER;
  if (override && (PROVIDER_ORDER as string[]).includes(override)) {
    const p = override as LLMProvider;
    // Provider-specific var wins; WIGOLO_LLM_API_KEY is the last-resort fallback
    // and is only honored here because the provider is explicitly named (#102).
    if (env[PROVIDER_ENV[p]] || env.WIGOLO_LLM_API_KEY) return p;
  }
  // Auto-detect: WIGOLO_LLM_API_KEY is ambiguous without an explicit provider,
  // so it is intentionally NOT consulted in this loop.
  for (const p of PROVIDER_ORDER) {
    if (env[PROVIDER_ENV[p]]) return p;
  }
  return null;
}

/**
 * Select a provider considering keystore (keychain/file) in addition to env.
 * Returns { provider, key } so the caller can use the key directly without
 * hydrating process.env. Returns null when no provider is configured.
 *
 * Resolution order:
 *   1. WIGOLO_LLM_PROVIDER env override (if key resolves in keystore or env)
 *   2. Persisted config.json `llmProvider` (if key resolves) — so a runtime
 *      with zero env vars honors the provider chosen during `wigolo init`.
 *   3. First provider in PROVIDER_ORDER whose key resolves (auto-detect,
 *      keychain → file → env via resolveProviderKey).
 */
export async function selectProviderWithKeyStore(
  env: Record<string, string | undefined>,
  opts: KeyStoreOpts,
): Promise<{ provider: LLMProvider; key: string } | null> {
  // Lazy import to avoid circular dep at module load time
  const { resolveProviderKey } = await import('../../../security/key-store.js');

  // Check custom backend first (no key needed): an http(s) URL OR the `ollama`
  // alias (from env or config.json) is keyless and handled separately in run.ts.
  // Returning null here keeps a configured-but-keyless ollama from accidentally
  // resolving to an unrelated cloud key during auto-detect.
  const envRaw = env.WIGOLO_LLM_PROVIDER;
  if (resolveCustomBackend(env) !== null) {
    return null;
  }

  // Explicit provider: env var wins, else fall back to the persisted
  // config.json value. resolvePersistedLlmProvider() reads only config.json so
  // env precedence stays in this function (env checked first above).
  const explicit = envRaw ?? resolvePersistedLlmProvider();
  if (explicit && (PROVIDER_ORDER as string[]).includes(explicit)) {
    const p = explicit as LLMProvider;
    const key = await resolveProviderKey(p, opts);
    if (key) return { provider: p, key };
    // Explicit provider specified but key not found — fall through to auto-detect
  }

  // Auto-detect: first provider with any key (keychain → file → env)
  for (const p of PROVIDER_ORDER) {
    const key = await resolveProviderKey(p, opts);
    if (key) return { provider: p, key };
  }

  return null;
}

/**
 * Read the persisted `llmProvider` from config.json (no env layer). Used as the
 * second tier of provider resolution: env override > config.json > auto-detect.
 * Returns null when unset or unreadable.
 */
function resolvePersistedLlmProvider(): string | null {
  const { settings } = readPersistedConfig(defaultConfigPath());
  const v = settings.llmProvider;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export function providerEnvVar(p: LLMProvider): string {
  return PROVIDER_ENV[p];
}

export function allProviders(): readonly LLMProvider[] {
  return PROVIDER_ORDER;
}
