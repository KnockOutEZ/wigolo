import type { LLMProvider } from './types.js';
import type { KeyStoreOpts } from '../../../security/key-store.js';

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
    if (env[PROVIDER_ENV[p]]) return p;
  }
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
 *   1. WIGOLO_LLM_PROVIDER override (if key resolves in keystore or env)
 *   2. First provider in PROVIDER_ORDER whose key resolves
 */
export async function selectProviderWithKeyStore(
  env: Record<string, string | undefined>,
  opts: KeyStoreOpts,
): Promise<{ provider: LLMProvider; key: string } | null> {
  // Lazy import to avoid circular dep at module load time
  const { resolveProviderKey } = await import('../../../security/key-store.js');

  // Check custom URL first (no key needed)
  const raw = env.WIGOLO_LLM_PROVIDER;
  if (raw && (raw.startsWith('http://') || raw.startsWith('https://'))) {
    // Custom URL — not a cloud provider, handled separately in run.ts
    return null;
  }

  // Explicit provider override
  if (raw && (PROVIDER_ORDER as string[]).includes(raw)) {
    const p = raw as LLMProvider;
    const key = await resolveProviderKey(p, opts);
    if (key) return { provider: p, key };
    // Override specified but key not found — fall through to auto-detect
  }

  // Auto-detect: first provider with any key
  for (const p of PROVIDER_ORDER) {
    const key = await resolveProviderKey(p, opts);
    if (key) return { provider: p, key };
  }

  return null;
}

export function providerEnvVar(p: LLMProvider): string {
  return PROVIDER_ENV[p];
}

export function allProviders(): readonly LLMProvider[] {
  return PROVIDER_ORDER;
}
