import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const pkg = JSON.parse(
  readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf-8'),
) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  overrides?: Record<string, string>;
};

describe('package.json: forbidden deps after Python-rerank migration', () => {
  // onnxruntime-node is intentionally allowed: fastembed (still the local
  // embedding backend) pulls it transitively and the v0.1.11 bench surfaced
  // npx consumers missing it when not hoisted to wigolo's own dependencies.
  // The other ONNX deps were banned because the rerank stack moved to Python.
  const FORBIDDEN = ['@xenova/transformers', 'onnx-proto', 'onnxruntime-web'];

  for (const name of FORBIDDEN) {
    it(`dependencies does not include ${name}`, () => {
      expect(pkg.dependencies?.[name]).toBeUndefined();
    });
    it(`devDependencies does not include ${name}`, () => {
      expect(pkg.devDependencies?.[name]).toBeUndefined();
    });
  }

  it('overrides.protobufjs is absent', () => {
    expect(pkg.overrides?.protobufjs).toBeUndefined();
  });

  it('engines.node is still >=20', () => {
    const node = (pkg as { engines?: { node?: string } }).engines?.node;
    expect(node).toBeDefined();
    expect(node).toMatch(/>=20/);
  });
});

// Regression guard for GitHub issues #114 / #101 — Linux reranker symbol clash.
//
// Two mandatory production deps each pin an EXACT native ONNX runtime:
//   - fastembed@2.1.0 (sole embedding backend) hard-pins onnxruntime-node@1.21.0
//     (built against napi-v3).
//   - @huggingface/transformers (cross-encoder reranker backend) pins an exact
//     onnxruntime-node too. At v4.2.0 that was 1.24.3 (napi-v6), which requires
//     the `VERS_1.24.3` symbol-version in libonnxruntime.so.1.
// Both native libs load in ONE process during warmup (warmEmbed + warmRerank).
// On Linux the dynamic linker reuses whichever libonnxruntime.so.1 got loaded
// first, so the mismatched consumer fails its symbol-version lookup:
//   `libonnxruntime.so.1: version 'VERS_1.24.3' not found`.
//
// The #101 attempt used an npm `overrides` block forcing a single 1.24.3 across
// the tree. THAT WAS WRONG for shipped consumers: npm only honors `overrides`
// from the install ROOT. When wigolo is installed as a *dependency* (exactly
// what `npx @staticn0va/wigolo` does), npm IGNORES wigolo's own `overrides`, so
// the two consumers split again and end users hit the clash anyway (#114).
//
// The correct fix is NATURAL CONVERGENCE: pin @huggingface/transformers to a
// version whose exact onnxruntime-node pin EQUALS fastembed's (1.21.0).
// transformers@3.5.0 pins onnxruntime-node@1.21.0 — the same version fastembed
// wants — so npm dedupes to a SINGLE 1.21.0 copy on its own, no root-only
// override required, and the fix actually reaches npx/Linux consumers.
//
// If a future dev re-splits the versions, bumps transformers back to a 4.x that
// re-introduces 1.24.3, re-adds a direct onnxruntime-node dep, or reintroduces
// the root-only override as the "fix", these tests MUST fail — that is the #114
// recurrence path.
describe('package.json: onnxruntime-node converges via natural alignment (issues #114/#101)', () => {
  it('has NO root-only onnxruntime-node override (npm ignores it under npx)', () => {
    expect(pkg.overrides?.['onnxruntime-node']).toBeUndefined();
  });

  it('declares NO direct onnxruntime-node dependency (it must come transitively)', () => {
    expect(pkg.dependencies?.['onnxruntime-node']).toBeUndefined();
  });

  it('pins @huggingface/transformers to 3.5.0 so its onnxruntime-node matches fastembed (1.21.0)', () => {
    expect(pkg.dependencies?.['@huggingface/transformers']).toBe('3.5.0');
  });

  it('exactly one onnxruntime-node version resolves in package-lock.json, and it is 1.21.0', () => {
    const lock = JSON.parse(
      readFileSync(join(__dirname, '..', '..', 'package-lock.json'), 'utf-8'),
    ) as { packages?: Record<string, { version?: string }> };

    const versions = new Set<string>();
    for (const [path, meta] of Object.entries(lock.packages ?? {})) {
      if (path.endsWith('node_modules/onnxruntime-node') && meta.version) {
        versions.add(meta.version);
      }
    }

    expect([...versions]).toEqual(['1.21.0']);
  });
});
