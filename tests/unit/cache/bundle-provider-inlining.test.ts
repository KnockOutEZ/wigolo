/**
 * The in-tree artifact provider must survive `packaging/binary/bundle.mjs`.
 *
 * WHY THIS EXISTS, and why the obvious tests did not catch it. The bootstrap originally held its
 * specifier as an array element (`const MODULES = ['../studio/artifact-provider.js']` iterated into
 * `await import(path)`). esbuild — which the binary bundler runs with `bundle: true, format: 'cjs'` —
 * CANNOT follow a non-literal specifier. It does not inline the module and it does not warn: it emits
 * the `import()` call verbatim. In the packaged binary that specifier resolved relative to
 * `dist/cli/agents/`, so `../studio/…` pointed at `dist/cli/studio/…` while the real file sits at
 * `dist/studio/…`. The bootstrap caught ENOENT, logged one `warn`, registered nothing, and every
 * captured clip, qa and note SILENTLY disappeared from `cache`, `find_similar` and `research` with no
 * error reaching the agent.
 *
 * Nothing in the normal matrix could see it: `tsup.config.ts` sets `bundle: false`, so npm and source
 * installs keep dist's structure and resolve fine, and every vitest run resolves from source. The
 * failure was reachable ONLY through the bundled binary. So this test does the one thing that
 * reproduces it — actually runs esbuild with the packaging flags and asserts the provider's own code
 * landed in the output.
 *
 * A textual "is the specifier a literal" assertion would be cheaper, but it would encode the CURRENT
 * fix rather than the PROPERTY. This asserts the property: whatever shape the bootstrap takes, the
 * provider must end up inside the bundle.
 */
import { describe, it, expect } from 'vitest';
import { build } from 'esbuild';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '../../..');

/** The packaging flags that matter for module resolution, from packaging/binary/bundle.mjs. */
async function bundleRegistry(): Promise<string> {
  const result = await build({
    entryPoints: [join(ROOT, 'src/cache/artifact-registry.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    write: false,
    // Keep the native/heavy leaves out; they are irrelevant to whether the PROVIDER got inlined,
    // and bundling them makes the test slow and brittle.
    external: ['better-sqlite3', 'sqlite-vec', 'fastembed', '@huggingface/transformers'],
    logLevel: 'silent',
  });
  return result.outputFiles[0].text;
}

describe('the in-tree artifact provider survives binary bundling', () => {
  it('esbuild inlines the provider module into the bundle', async () => {
    const bundled = await bundleRegistry();

    // The provider's exported symbol and its provider id must both be present. With a non-literal
    // specifier esbuild emits the import call verbatim and neither appears — which is exactly the
    // state that shipped a silently empty artifact surface.
    expect(bundled).toContain('studioArtifactProvider');
    expect(bundled).toContain('STUDIO_ARTIFACT_PROVIDER');
  }, 60_000);

  it('no dynamic import survives the bundle, and the specifier does not linger as data', async () => {
    const bundled = await bundleRegistry();

    // Two independent fingerprints of a passed-through import, because the regression can take
    // either shape and each one alone misses the other:
    //
    //  - a VARIABLE specifier (`import(path)` over an array of strings — the shape that actually
    //    shipped) leaves the path behind as a plain data string and emits a bare `import(` call;
    //  - a LITERAL specifier that esbuild declined to follow would leave the call with the path
    //    inline.
    //
    // When the provider is properly inlined esbuild emits neither: measured on this bundle,
    // dynamic import calls = 0 and the specifier string is absent.
    expect(bundled, 'a dynamic import() survived — esbuild did not inline the provider')
      .not.toMatch(/\bimport\(/);
    expect(bundled, 'the module specifier lingers as a data string — it was never followed')
      .not.toContain('../studio/artifact-provider');
  }, 60_000);

  it("the provider's artifact-type policy is inlined too, not just its name", async () => {
    const bundled = await bundleRegistry();

    // Research eligibility is provider policy now. If only a stub survived bundling, artifacts would
    // still vanish from `research` even with the provider nominally registered.
    for (const type of ['clip', 'qa', 'note']) {
      expect(bundled, `researchable type ${type} missing from bundle`).toContain(`"${type}"`);
    }
  }, 60_000);
});
