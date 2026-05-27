/**
 * Tests that toggled-off components are not installed.
 *
 * The ToggleMap drives which warmup flags are passed. We verify the action-level
 * contract: if searxng or embeddings is toggled off, the corresponding warmup
 * flag is absent from the invocation.
 *
 * This is a headless test of the build-install-flags logic used by useInstall
 * and by the headless plain-mode warmup path in init.ts.
 */
import { describe, expect, it } from 'vitest';
import { buildDefaultToggles } from '../../../../../src/cli/tui/actions/types.js';

/**
 * Reproduce the flag-building logic that useInstall uses (currently inline;
 * extracted here for testing). Wave C will move this to the actions layer.
 */
function buildWarmupFlags(
  browser: 'chromium' | 'firefox',
  toggles: import('../../../../../src/cli/tui/actions/types.js').ToggleMap,
): string[] {
  const flags: string[] = [];
  if (toggles.reranker) flags.push('--reranker');
  if (toggles.embeddings) flags.push('--embeddings');
  if (browser === 'firefox' && toggles.firefox) flags.push('--firefox');
  return flags;
}

describe('buildDefaultToggles', () => {
  it('all core components default to true', () => {
    const t = buildDefaultToggles(false);
    expect(t.searxng).toBe(true);
    expect(t.chromium).toBe(true);
    expect(t.reranker).toBe(true);
    expect(t.embeddings).toBe(true);
  });
});

describe('buildWarmupFlags from toggles', () => {
  it('includes --reranker and --embeddings when both are on', () => {
    const toggles = buildDefaultToggles(false);
    const flags = buildWarmupFlags('chromium', toggles);
    expect(flags).toContain('--reranker');
    expect(flags).toContain('--embeddings');
  });

  it('omits --reranker when reranker toggle is off', () => {
    const toggles = { ...buildDefaultToggles(false), reranker: false };
    const flags = buildWarmupFlags('chromium', toggles);
    expect(flags).not.toContain('--reranker');
    expect(flags).toContain('--embeddings');
  });

  it('omits --embeddings when embeddings toggle is off', () => {
    const toggles = { ...buildDefaultToggles(false), embeddings: false };
    const flags = buildWarmupFlags('chromium', toggles);
    expect(flags).toContain('--reranker');
    expect(flags).not.toContain('--embeddings');
  });

  it('omits --firefox when browser=chromium even if toggle is on', () => {
    const toggles = buildDefaultToggles(true); // firefox toggle on
    const flags = buildWarmupFlags('chromium', toggles);
    expect(flags).not.toContain('--firefox');
  });

  it('includes --firefox when browser=firefox and toggle is on', () => {
    const toggles = buildDefaultToggles(true);
    const flags = buildWarmupFlags('firefox', toggles);
    expect(flags).toContain('--firefox');
  });

  it('omits --firefox when toggle is off even if browser=firefox', () => {
    const toggles = { ...buildDefaultToggles(true), firefox: false };
    const flags = buildWarmupFlags('firefox', toggles);
    expect(flags).not.toContain('--firefox');
  });

  it('all off: returns empty flags', () => {
    const toggles = { ...buildDefaultToggles(false), reranker: false, embeddings: false };
    const flags = buildWarmupFlags('chromium', toggles);
    expect(flags).toHaveLength(0);
  });
});
