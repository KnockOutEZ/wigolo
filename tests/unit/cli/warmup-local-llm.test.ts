import { describe, it, expect } from 'vitest';
import { formatLocalLlmWarmupLine } from '../../../src/cli/warmup.js';

// The local-model tier is opt-in and warmup does not install models — it only
// reports the resolved state. formatLocalLlmWarmupLine is pure so the branching
// is asserted without a live server or a full runWarmup run.
describe('formatLocalLlmWarmupLine', () => {
  it("reports off (default) so the opt-in lever stays discoverable", () => {
    const line = formatLocalLlmWarmupLine({ localLlm: 'off', tier: null });
    expect(line).toMatch(/local language model/i);
    expect(line).toMatch(/off/i);
  });

  it("reports the endpoint + model when a local model is reachable", () => {
    const line = formatLocalLlmWarmupLine({
      localLlm: 'auto',
      tier: { available: true, endpoint: 'http://localhost:11434', model: 'qwen2.5:7b-instruct', source: 'auto' },
    });
    expect(line).toContain('http://localhost:11434');
    expect(line).toContain('qwen2.5:7b-instruct');
    expect(line).toMatch(/reachable|ready/i);
  });

  it("reports enabled-but-unreachable gracefully (no crash, falls back)", () => {
    // WHY: warmup with the flag on but no server up must not fail — it reports
    // the absence so the user knows synthesis will use the keyless path.
    const line = formatLocalLlmWarmupLine({ localLlm: 'auto', tier: null });
    expect(line).toMatch(/auto/);
    expect(line).toMatch(/not reachable|unreachable|not detected|keyless/i);
  });

  it("sanitizes an untrusted model name", () => {
    const line = formatLocalLlmWarmupLine({
      localLlm: 'auto',
      tier: { available: true, endpoint: 'http://localhost:11434', model: 'm\x1b[2Jx', source: 'auto' },
    });
    expect(line).not.toMatch(/\x1b/);
    expect(line).toContain('m[2Jx');
  });
});
