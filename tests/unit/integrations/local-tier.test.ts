import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveLocalModelTier,
  resetLocalModelTierCache,
  type LocalModelTier,
} from '../../../src/integrations/cloud/llm/local-tier.js';
import { isLlmConfigured } from '../../../src/integrations/cloud/llm/run.js';
import { resetConfig } from '../../../src/config.js';
import { resetPersistedConfig } from '../../../src/persisted-config.js';

// Deterministic, network-free tests: the probe + model pick are always injected,
// so no live server is ever contacted. resetLocalModelTierCache() clears the
// process-lifetime negative cache between cases so one test's miss can't leak.

const okProbe = vi.fn(async () => ({ reachable: true }));
const downProbe = vi.fn(async () => ({ reachable: false }));

describe('resolveLocalModelTier', () => {
  const originalEnv = process.env;
  let tmpConfigDir: string;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.WIGOLO_LOCAL_LLM;
    delete process.env.WIGOLO_LOCAL_LLM_MODEL;
    delete process.env.WIGOLO_LOCAL_LLM_BASE_URL;
    delete process.env.WIGOLO_LLM_BASE_URL;
    // Hermetic: an empty config dir so isLlmConfigured()'s persisted-config read
    // (llmProvider: "ollama") can't leak in from the real ~/.wigolo/config.json.
    tmpConfigDir = mkdtempSync(join(tmpdir(), 'wigolo-local-tier-test-'));
    process.env.WIGOLO_CONFIG_PATH = join(tmpConfigDir, 'config.json');
    resetPersistedConfig();
    resetConfig();
    resetLocalModelTierCache();
    okProbe.mockClear();
    downProbe.mockClear();
  });

  afterEach(() => {
    process.env = originalEnv;
    rmSync(tmpConfigDir, { recursive: true, force: true });
    resetPersistedConfig();
    resetConfig();
    resetLocalModelTierCache();
  });

  it("returns null and makes NO probe when the flag is off (default)", async () => {
    // WHY: OFF is the default; the keyless benchmark path must be byte-for-byte
    // identical, which means not a single network probe when the tier is off.
    const probe = vi.fn(async () => ({ reachable: true }));
    const result = await resolveLocalModelTier({ localLlm: 'off', probe });
    expect(result).toBeNull();
    expect(probe).not.toHaveBeenCalled();
  });

  it("returns an available tier when auto + server present (mocked probe)", async () => {
    const pickModel = vi.fn(async () => 'qwen2.5:7b-instruct');
    const result = await resolveLocalModelTier({
      localLlm: 'auto',
      probe: okProbe,
      pickModel,
    });
    expect(result).toEqual<LocalModelTier>({
      available: true,
      endpoint: 'http://localhost:11434',
      model: 'qwen2.5:7b-instruct',
      source: 'auto',
    });
  });

  it("returns null gracefully when auto + server absent (mocked failing probe)", async () => {
    // WHY: an absent local server is a normal, non-error state — the resolver
    // must degrade to null (caller falls back down the ladder), never throw.
    const result = await resolveLocalModelTier({ localLlm: 'auto', probe: downProbe });
    expect(result).toBeNull();
  });

  it("caches the negative for the process — a second miss makes NO second probe", async () => {
    // WHY: a missing server must cost at most ONE fast probe for the whole
    // process lifetime, never a per-call latency penalty on the hot path.
    const probe = vi.fn(async () => ({ reachable: false }));
    const first = await resolveLocalModelTier({ localLlm: 'auto', probe });
    const second = await resolveLocalModelTier({ localLlm: 'auto', probe });
    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("never throws when the probe itself rejects — resolves null", async () => {
    const probe = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(resolveLocalModelTier({ localLlm: 'auto', probe })).resolves.toBeNull();
  });

  it("probes an explicit http endpoint value instead of the default", async () => {
    const pickModel = vi.fn(async () => 'llama3.1:8b');
    const result = await resolveLocalModelTier({
      localLlm: 'http://box:9999',
      probe: okProbe,
      pickModel,
    });
    expect(okProbe).toHaveBeenCalledWith('http://box:9999');
    expect(result).toEqual<LocalModelTier>({
      available: true,
      endpoint: 'http://box:9999',
      model: 'llama3.1:8b',
      source: 'endpoint',
    });
  });

  it("honors WIGOLO_LOCAL_LLM_MODEL over the auto-pick", async () => {
    // WHY: a user who names a model must get exactly that model — the pick is a
    // fallback for the unset case, not an override of an explicit choice.
    process.env.WIGOLO_LOCAL_LLM_MODEL = 'mistral:7b';
    const pickModel = vi.fn(async () => 'should-not-be-used');
    const result = await resolveLocalModelTier({
      localLlm: 'auto',
      localLlmModel: 'mistral:7b',
      probe: okProbe,
      pickModel,
    });
    expect(result?.model).toBe('mistral:7b');
    expect(pickModel).not.toHaveBeenCalled();
  });

  it("prefers WIGOLO_LOCAL_LLM_BASE_URL for the auto endpoint", async () => {
    process.env.WIGOLO_LOCAL_LLM_BASE_URL = 'http://gpu-box:11434';
    const result = await resolveLocalModelTier({
      localLlm: 'auto',
      probe: okProbe,
      pickModel: async () => 'm',
    });
    expect(result?.endpoint).toBe('http://gpu-box:11434');
  });

  it("caches the positive too — a second hit makes NO second probe", async () => {
    const probe = vi.fn(async () => ({ reachable: true }));
    const pickModel = vi.fn(async () => 'm');
    await resolveLocalModelTier({ localLlm: 'auto', probe, pickModel });
    await resolveLocalModelTier({ localLlm: 'auto', probe, pickModel });
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("does NOT make isLlmConfigured() true — the local tier is add-alongside", () => {
    // WHY: the non-negotiable OFF guarantee. Setting the new local-tier knob
    // must not leak into the existing configured-check; with no cloud key and
    // no WIGOLO_LLM_PROVIDER, isLlmConfigured() must still be false whether the
    // local flag is off OR auto — otherwise every keyless path would silently
    // change behavior.
    const keyless: Record<string, string | undefined> = {
      WIGOLO_LLM_PROVIDER: undefined,
      ANTHROPIC_API_KEY: undefined,
      OPENAI_API_KEY: undefined,
      GOOGLE_API_KEY: undefined,
      GEMINI_API_KEY: undefined,
      GROQ_API_KEY: undefined,
      WIGOLO_LLM_API_KEY: undefined,
    };
    expect(isLlmConfigured({ ...keyless })).toBe(false);
    expect(isLlmConfigured({ ...keyless, WIGOLO_LOCAL_LLM: 'auto' })).toBe(false);
  });
});
