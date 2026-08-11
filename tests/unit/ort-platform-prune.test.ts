import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain-JS build tooling, deliberately not part of the typed src/ graph.
import { planPlatformPrune, locateOrtRoots } from '../../scripts/prune/ort-platforms.mjs';

/*
 * WHY these tests exist.
 *
 * The prune deletes 178 MiB of prebuilt native runtimes out of a user's install, and the ONE
 * directory it must never delete is the one that gets loaded. That decision — which pairs go,
 * which stays — is the whole risk, so it lives in a pure function and is tested here rather
 * than being discoverable only by running an install and seeing whether inference still works.
 *
 * The measurement that motivates it is not repeated here, because a unit test cannot perform
 * an npm install; it is recorded on the G-DIET gate. What IS testable is the decision, and
 * every assertion below is about a way the decision could strand a user.
 *
 * The real six-pair layout of onnxruntime-node@1.21.0, as shipped.
 */
const FULL_TREE = {
  darwin: ['arm64', 'x64'],
  linux: ['arm64', 'x64'],
  win32: ['arm64', 'x64'],
};

const ALL_HOSTS: Array<[string, string]> = [
  ['darwin', 'arm64'],
  ['darwin', 'x64'],
  ['linux', 'arm64'],
  ['linux', 'x64'],
  ['win32', 'arm64'],
  ['win32', 'x64'],
];

describe('planPlatformPrune keeps exactly the pair that can be loaded', () => {
  it('keeps the host pair and removes the other five', () => {
    const plan = planPlatformPrune(FULL_TREE, 'darwin', 'arm64');
    expect(plan.keep).toBe('darwin/arm64');
    expect(plan.remove).toEqual(['darwin/x64', 'linux/arm64', 'linux/x64', 'win32/arm64', 'win32/x64']);
  });

  it('removes the SAME-platform other architecture too', () => {
    // The tempting shortcut is to prune whole platform directories, which is also how the
    // opportunity was first sized (linux + win32 = 144 MiB). It leaves darwin/x64 behind — 34 MiB
    // on this host that nothing on an arm64 machine can ever load. Pruning by PAIR rather than by
    // platform is worth the extra 34 MiB, and this is the assertion that would notice a later
    // simplification quietly giving it back.
    expect(planPlatformPrune(FULL_TREE, 'darwin', 'arm64').remove).toContain('darwin/x64');
  });

  it('never proposes removing the host pair, from any of the six hosts', () => {
    for (const [platform, arch] of ALL_HOSTS) {
      const plan = planPlatformPrune(FULL_TREE, platform, arch);
      expect(plan.remove, `${platform}/${arch}`).not.toContain(`${platform}/${arch}`);
      expect(plan.remove).toHaveLength(5);
      expect(plan.keep).toBe(`${platform}/${arch}`);
    }
  });
});

describe('planPlatformPrune refuses rather than guesses when it cannot find the host binary', () => {
  it('removes NOTHING when the host platform is absent', () => {
    // ⚠ The case that decides whether this script can strand someone. If the layout is not what
    // we believe — a future onnxruntime-node that renames its directories, a platform we have
    // never seen — then every candidate for removal might be the one that loads. Removing
    // nothing costs bytes. Removing the wrong thing costs the user their install, and it does so
    // AFTER npm reports success.
    const plan = planPlatformPrune(FULL_TREE, 'freebsd', 'x64');
    expect(plan.remove).toEqual([]);
    expect(plan.keep).toBeNull();
    expect(plan.reason).toContain('refusing to prune');
  });

  it('removes NOTHING when the host platform is present but the host ARCH is not', () => {
    // Distinct from the case above and easy to get wrong: a tree that has `darwin` would satisfy
    // a platform-level check while still having no binary an arm64 process can load. Node's
    // require path is the PAIR, so the guard has to be stated over the pair.
    const plan = planPlatformPrune({ darwin: ['x64'], linux: ['x64'] }, 'darwin', 'arm64');
    expect(plan.remove).toEqual([]);
    expect(plan.keep).toBeNull();
  });

  it('is idempotent — a second run over an already-pruned tree removes nothing', () => {
    // npm re-runs a package's postinstall on installs that did not re-extract that package, so
    // this runs many times over the same tree. The second run must be a no-op and must not
    // report a refusal, which would read as a fault in the logs of a perfectly healthy install.
    const plan = planPlatformPrune({ darwin: ['arm64'] }, 'darwin', 'arm64');
    expect(plan.remove).toEqual([]);
    expect(plan.keep).toBe('darwin/arm64');
    expect(plan.reason).not.toContain('refusing');
  });

  it('tolerates the emptied platform directories a previous run leaves behind', () => {
    // The driver removes non-host platform dirs once their arches are gone, but a failed or
    // interrupted removal can leave an empty `linux/`. That must read as "nothing to do", not as
    // a platform whose absence of arches means something.
    const plan = planPlatformPrune({ darwin: ['arm64'], linux: [], win32: [] }, 'darwin', 'arm64');
    expect(plan.remove).toEqual([]);
    expect(plan.keep).toBe('darwin/arm64');
  });
});

describe('locateOrtRoots finds every copy without requiring every consumer', () => {
  it('deduplicates consumers that resolve to one hoisted copy', () => {
    // The ordinary tree: fastembed and @huggingface/transformers both pin 1.21.0, npm hoists one
    // copy, and all three resolution attempts land on it. Pruning it three times would be
    // harmless but would report the freed bytes three times over.
    expect(locateOrtRoots(() => '/nm/onnxruntime-node')).toEqual(['/nm/onnxruntime-node']);
  });

  it('returns every DISTINCT copy when hoisting was defeated', () => {
    const byConsumer: Record<string, string> = {
      'fastembed': '/nm/fastembed/node_modules/onnxruntime-node',
      '@huggingface/transformers': '/nm/onnxruntime-node',
    };
    const roots = locateOrtRoots((c: string | null) => (c === null ? '/nm/onnxruntime-node' : byConsumer[c]));
    expect(roots.sort()).toEqual(['/nm/fastembed/node_modules/onnxruntime-node', '/nm/onnxruntime-node']);
  });

  it('keeps going when a consumer is not installed', () => {
    // Resolution throwing is ordinary, not exceptional: a tree that installed one consumer and
    // not the other is a supported tree. If one throw aborted the walk, that tree would silently
    // keep its 178 MiB while the log said nothing.
    const roots = locateOrtRoots((c: string | null) => {
      if (c === 'fastembed') throw new Error('MODULE_NOT_FOUND');
      return '/nm/onnxruntime-node';
    });
    expect(roots).toEqual(['/nm/onnxruntime-node']);
  });

  it('returns nothing when onnxruntime-node is not in the tree at all', () => {
    expect(
      locateOrtRoots(() => {
        throw new Error('MODULE_NOT_FOUND');
      }),
    ).toEqual([]);
  });
});
