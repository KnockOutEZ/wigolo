/**
 * The bootstrap's failure `warn` is the ENTIRE diagnostic for the silent-degradation mode.
 *
 * When an in-tree provider module fails to load, `ensureArtifactProviders()` catches, logs once, and
 * registers nothing — every captured artifact then disappears from `cache`, `find_similar` and
 * `research` with no error reaching the agent. That is by design (an unavailable surface must not fail
 * the query), which is exactly why the one log line has to identify WHICH loader died.
 *
 * This regressed once already: moving from an array of path strings to thunks dropped the `module`
 * field, and it stayed diagnosable only by luck — the old failure was a module-resolution error whose
 * MESSAGE happened to contain the path. A provider that throws during module EVALUATION produces an
 * error naming nothing at all, which is the case pinned below.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const warns: Array<{ msg: string; data?: Record<string, unknown> }> = [];

vi.mock('../../../src/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: (msg: string, data?: Record<string, unknown>) => { warns.push({ msg, data }); },
    error: vi.fn(),
  }),
}));

// A provider module that loads but blows up when its export is read — the realistic "module is
// there, the provider is broken" case, and one whose error text names nothing about the module.
vi.mock('../../../src/companion/artifact-provider.js', () => ({
  get studioArtifactProvider(): never {
    throw new Error('exploded while evaluating the export');
  },
}));

describe('artifact bootstrap failure diagnostic', () => {
  beforeEach(async () => {
    warns.length = 0;
    const { clearArtifactProviders } = await import('../../../src/cache/artifact-registry.js');
    clearArtifactProviders();
  });
  afterEach(async () => {
    const { clearArtifactProviders } = await import('../../../src/cache/artifact-registry.js');
    clearArtifactProviders();
  });

  it('degrades to no providers rather than throwing — the query must still run', async () => {
    const { ensureArtifactProviders } = await import('../../../src/cache/artifact-registry.js');
    await expect(ensureArtifactProviders()).resolves.toEqual([]);
  });

  it('logs exactly one warn that IDENTIFIES the failing loader', async () => {
    const { ensureArtifactProviders } = await import('../../../src/cache/artifact-registry.js');
    await ensureArtifactProviders();

    const hits = warns.filter((w) => w.msg.includes('artifact provider module unavailable'));
    expect(hits).toHaveLength(1);

    // The identifying field. Without it this line reads "something, somewhere, failed" — and since
    // the failure is otherwise silent, that is indistinguishable from "there were no artifacts".
    expect(hits[0].data).toHaveProperty('loaderIndex');
    expect(typeof hits[0].data?.loaderIndex).toBe('number');
    expect(hits[0].data?.loaderCount).toBeGreaterThan(0);

    // And the underlying error is still carried, not swallowed by the identifier.
    expect(String(hits[0].data?.error)).toContain('exploded while evaluating');
  });

  it('the identifier does not depend on the error text naming the module', async () => {
    const { ensureArtifactProviders } = await import('../../../src/cache/artifact-registry.js');
    await ensureArtifactProviders();

    const hit = warns.find((w) => w.msg.includes('artifact provider module unavailable'))!;
    // The whole point: this error mentions no path at all. The old `{ module: path }` shape was
    // readable only because a RESOLUTION error happened to embed the specifier in its message.
    expect(String(hit.data?.error)).not.toContain('artifact-provider');
    expect(hit.data?.loaderIndex).toBe(0);
  });
});
