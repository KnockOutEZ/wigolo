import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// maybePrintOllamaHint is the shared detect->hint helper called by BOTH init
// paths (Ink wizard via runInit, non-interactive via runInitPlain). We mock the
// probe + the configured-check so the helper's branching is asserted without a
// live server or real keychain.
const { probeOllamaMock, isLlmConfiguredMock } = vi.hoisted(() => ({
  probeOllamaMock: vi.fn(),
  isLlmConfiguredMock: vi.fn(),
}));

vi.mock('../../../src/cli/ollama-probe.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/cli/ollama-probe.js')>(
    '../../../src/cli/ollama-probe.js',
  );
  return { ...actual, probeOllama: probeOllamaMock };
});

vi.mock('../../../src/integrations/cloud/llm/run.js', () => ({
  isLlmConfigured: isLlmConfiguredMock,
}));

import { maybePrintOllamaHint } from '../../../src/cli/init.js';

describe('maybePrintOllamaHint (shared by both init paths)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.WIGOLO_LLM_BASE_URL;
  });
  afterEach(() => {
    delete process.env.WIGOLO_LLM_BASE_URL;
  });

  it('prints a hint when a local server is reachable and no LLM is configured', async () => {
    // WHY: this is the discoverability payoff — a user running Ollama with no
    // configured LLM must be told the keyless lever exists during init.
    probeOllamaMock.mockResolvedValue({ reachable: true });
    isLlmConfiguredMock.mockReturnValue(false);
    const lines: string[] = [];
    await maybePrintOllamaHint((l) => lines.push(l));
    expect(lines.join('\n')).toMatch(/WIGOLO_LLM_PROVIDER=ollama/);
  });

  it('prints NOTHING when an LLM is already configured (no nag)', async () => {
    probeOllamaMock.mockResolvedValue({ reachable: true });
    isLlmConfiguredMock.mockReturnValue(true);
    const lines: string[] = [];
    await maybePrintOllamaHint((l) => lines.push(l));
    expect(lines).toEqual([]);
  });

  it('prints NOTHING and never throws when no server is reachable', async () => {
    probeOllamaMock.mockResolvedValue({ reachable: false });
    isLlmConfiguredMock.mockReturnValue(false);
    const lines: string[] = [];
    await expect(maybePrintOllamaHint((l) => lines.push(l))).resolves.toBeUndefined();
    expect(lines).toEqual([]);
  });

  it('swallows a probe failure — a hint error must never break init', async () => {
    // WHY: detection is best-effort; if the probe itself throws, init must
    // proceed unaffected (no error, no exit-code change).
    probeOllamaMock.mockRejectedValue(new Error('boom'));
    isLlmConfiguredMock.mockReturnValue(false);
    const lines: string[] = [];
    await expect(maybePrintOllamaHint((l) => lines.push(l))).resolves.toBeUndefined();
    expect(lines).toEqual([]);
  });
});
