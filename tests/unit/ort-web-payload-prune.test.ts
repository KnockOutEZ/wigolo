import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain-JS build tooling, deliberately not part of the typed src/ graph.
import { planWebPayloadPrune, findWebDependents } from '../../scripts/prune/ort-web-payload.mjs';

/*
 * WHY these tests exist.
 *
 * The prune deletes 86 MiB out of a user's install, and it deletes it from a package this
 * repository does not own and did not ask for. The safety argument has two halves. The first —
 * that @huggingface/transformers' Node build never loads onnxruntime-web — was established by
 * running both production ML paths and reading Node's module registry afterwards: onnxruntime-node
 * loaded 5 files including the native binding, onnxruntime-web loaded zero, and with the payload
 * removed all 16 recorded inference assertions came back bit-identical. That half cannot be
 * unit-tested; it is recorded on the G-DIET gate and in ort-web-payload.mjs.
 *
 * The second half is what happens when that argument does NOT hold — when some OTHER package in
 * the tree wants the browser build. Then deleting it strands a consumer this repository has never
 * heard of, and the only defence is that the planner refuses. That decision is pure, so it is
 * tested here, and every assertion below is about a way the decision could strand somebody.
 */

const OWNER = '@huggingface/transformers';

describe('planWebPayloadPrune removes the payload only when nothing else wants it', () => {
  it('removes dist/ when the owner is the sole dependent', () => {
    const plan = planWebPayloadPrune([OWNER]);
    expect(plan.remove).toEqual(['dist']);
    expect(plan.reason).toContain('only dependent');
  });

  it('removes ONLY dist/, never the package directory', () => {
    // The 5 MiB this leaves behind is not an oversight. `npm ls` must still resolve
    // onnxruntime-web as a dependency of @huggingface/transformers — it is noise in every user's
    // tree otherwise, and a hard failure in pipelines that run it strictly. Verified against a
    // real pruned install, where `npm ls onnxruntime-web` still prints the resolved dependency.
    // A later "simplification" to remove the whole directory would save 5 MiB and break that.
    const plan = planWebPayloadPrune([OWNER]);
    expect(plan.remove).not.toContain('');
    expect(plan.remove.every((p: string) => p === 'dist')).toBe(true);
  });

  it('still prunes when the owner is listed more than once', () => {
    // A tree with a nested copy names the same dependent twice. That is not a foreign consumer.
    expect(planWebPayloadPrune([OWNER, OWNER]).remove).toEqual(['dist']);
  });
});

describe('planWebPayloadPrune refuses rather than strand a consumer it does not know about', () => {
  it('refuses when the install root also depends on onnxruntime-web', () => {
    // The likeliest foreign consumer by far: an application that embeds wigolo AND runs its own
    // in-browser inference. Our postinstall runs in THEIR tree. Deleting the payload there breaks
    // a build that has nothing to do with us, and the bytes are not worth it.
    const plan = planWebPayloadPrune([OWNER, '<install-root>']);
    expect(plan.remove).toEqual([]);
    expect(plan.reason).toContain('refusing');
  });

  it('refuses for any other package, not just the install root', () => {
    const plan = planWebPayloadPrune([OWNER, 'some-other-ml-lib']);
    expect(plan.remove).toEqual([]);
    expect(plan.reason).toContain('some-other-ml-lib');
  });

  it('names every foreign dependent, so the refusal is actionable', () => {
    // A refusal that says only "something else needs it" sends the reader to grep the tree by
    // hand. The whole point of scanning is that we already know the answer.
    const plan = planWebPayloadPrune([OWNER, 'zeta-pkg', 'alpha-pkg']);
    expect(plan.reason).toContain('alpha-pkg');
    expect(plan.reason).toContain('zeta-pkg');
    expect(plan.reason.indexOf('alpha-pkg')).toBeLessThan(plan.reason.indexOf('zeta-pkg'));
  });

  it('refuses on an EMPTY dependent set instead of treating it as permission', () => {
    // ⚠ The subtle one, and the reason it is asserted rather than assumed. "Nobody depends on it"
    // reads like the safest possible case to delete. It is actually the least trustworthy: a
    // package present in the tree with no dependent is far more likely to mean the scan failed —
    // an unreadable manifest, a layout we do not understand — than to mean npm installed 91 MiB
    // for no reason. Treating a failed scan as consent is how fail-open becomes fail-dangerous.
    const plan = planWebPayloadPrune([]);
    expect(plan.remove).toEqual([]);
    expect(plan.reason).toContain('scan may have failed');
  });
});

describe('findWebDependents sees a dependency however it is declared', () => {
  it('finds a plain dependencies entry', () => {
    const tree = { [OWNER]: { dependencies: { 'onnxruntime-web': '1.22.0' } } };
    expect(findWebDependents(tree)).toEqual([OWNER]);
  });

  it('finds optionalDependencies and peerDependencies too', () => {
    // A package that declares onnxruntime-web as OPTIONAL still loads it when it is present, and
    // present is exactly the state this prune would be changing. Scanning only `dependencies`
    // would report such a consumer as absent and hand back a confident, wrong permission.
    expect(findWebDependents({ a: { optionalDependencies: { 'onnxruntime-web': '*' } } })).toEqual(['a']);
    expect(findWebDependents({ b: { peerDependencies: { 'onnxruntime-web': '*' } } })).toEqual(['b']);
  });

  it('ignores packages that depend on something else entirely', () => {
    const tree = {
      innocent: { dependencies: { 'onnxruntime-node': '1.21.0' } },
      [OWNER]: { dependencies: { 'onnxruntime-web': '1.22.0' } },
    };
    expect(findWebDependents(tree)).toEqual([OWNER]);
  });

  it('counts a package once even when it declares the dep in two fields', () => {
    // Otherwise a single package looks like two dependents, and the planner — which refuses on
    // anything beyond the owner — would refuse on the owner itself and silently lose the win.
    const tree = {
      [OWNER]: {
        dependencies: { 'onnxruntime-web': '1.22.0' },
        optionalDependencies: { 'onnxruntime-web': '1.22.0' },
      },
    };
    expect(findWebDependents(tree)).toEqual([OWNER]);
    expect(planWebPayloadPrune(findWebDependents(tree)).remove).toEqual(['dist']);
  });

  it('survives a null or malformed manifest without throwing', () => {
    // A postinstall that throws is a postinstall that fails somebody's install. Every unreadable
    // entry must degrade to "not a dependent", which can only make the planner MORE willing to
    // prune — which is safe ONLY because an empty result is itself a refusal.
    const tree = { broken: null, alsoBroken: {}, [OWNER]: { dependencies: { 'onnxruntime-web': '1' } } };
    expect(() => findWebDependents(tree)).not.toThrow();
    expect(findWebDependents(tree)).toEqual([OWNER]);
  });
});
