import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { builtinModules } from 'node:module';
import ts from 'typescript';

const repoRoot = join(__dirname, '..', '..');

const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8')) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
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

  // Node 20 "Iron" went EOL upstream on 2026-03-24. The floor tracks a
  // SUPPORTED LTS line, so this asserts the EOL floor is gone rather than just
  // that some floor is declared — a silent revert to >=20 would put installs
  // back on a runtime that receives no security fixes, and `npm install` would
  // stop warning about it.
  it('engines.node is >=22 — the EOL Node 20 floor is gone', () => {
    const node = (pkg as { engines?: { node?: string } }).engines?.node;
    expect(node).toBeDefined();
    expect(node).toMatch(/>=22/);
    expect(node).not.toMatch(/>=(18|20)\b/);
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
// what `npx wigolo` does), npm IGNORES wigolo's own `overrides`, so
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

// ---------------------------------------------------------------------------
// Phantom dependencies.
//
// `sharp` was imported at the top of src/extraction/brand-palette.ts and
// declared NOWHERE in package.json. It resolved only because
// @huggingface/transformers lists it as a required dependency and npm hoisted
// it to the tree root — a coincidence of one package manager's layout. The
// module docstring even recorded the reasoning ("already a transitive
// dependency … so no new bundle cost"), which is why a guard on the WORDING is
// worthless and a guard on the SHAPE is not.
//
// That shape breaks silently on: a transformers bump that drops sharp, an
// install under pnpm or Yarn PnP (no root hoisting), `npm dedupe` moving the
// copy, or a bundler asked to resolve a package the manifest never named.
// Nothing in the type checker or the test suite could see it, because the file
// compiled and ran fine against the hoisted copy.
//
// So this test does not check for sharp. It checks the class: every bare
// specifier imported anywhere in src/ must be a Node builtin or a package this
// manifest actually declares. A future phantom fails here on the day it is
// written rather than on a user's machine.
// ---------------------------------------------------------------------------
function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collectSourceFiles(full, out);
    else if (/\.(ts|tsx|mts|cts)$/.test(entry)) out.push(full);
  }
  return out;
}

/** `@scope/pkg/deep/path` -> `@scope/pkg`; `pkg/deep/path` -> `pkg`. */
function packageRoot(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/**
 * Module specifiers via the TypeScript AST rather than a regex — a regex over
 * source text picks up the word "from" inside string literals and comments,
 * which produces exactly the kind of noisy guard people disable.
 */
function moduleSpecifiers(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf-8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const specs: string[] = [];

  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specs.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire =
        ts.isIdentifier(node.expression) && node.expression.text === 'require';
      const [first] = node.arguments;
      if ((isDynamicImport || isRequire) && first && ts.isStringLiteral(first)) {
        specs.push(first.text);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return specs;
}

describe('package.json: no phantom dependencies in src/', () => {
  const declared = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ]);
  const builtins = new Set(builtinModules);

  const undeclared = new Map<string, Set<string>>();
  for (const file of collectSourceFiles(join(repoRoot, 'src'))) {
    for (const spec of moduleSpecifiers(file)) {
      if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) continue;
      const name = packageRoot(spec);
      if (builtins.has(name) || declared.has(name)) continue;
      const seen = undeclared.get(name) ?? new Set<string>();
      seen.add(file.slice(repoRoot.length + 1));
      undeclared.set(name, seen);
    }
  }

  it('every package imported by src/ is declared in package.json', () => {
    const report = [...undeclared]
      .map(([name, files]) => `${name} <- ${[...files].join(', ')}`)
      .sort();
    expect(report).toEqual([]);
  });

  it('finds the imports it claims to scan (guard against an empty scan)', () => {
    // A scan that silently walks nothing would pass the test above forever.
    // Pin a specifier we know is imported so the scan cannot go quiet.
    const all = collectSourceFiles(join(repoRoot, 'src')).flatMap(moduleSpecifiers);
    expect(all).toContain('sharp');
    expect(all.length).toBeGreaterThan(500);
  });

  it('declares sharp directly rather than riding transformers hoisting', () => {
    expect(pkg.dependencies?.sharp).toBeDefined();
  });

  it('resolves exactly one sharp version, shared with @huggingface/transformers', () => {
    // Declaring sharp directly must DEDUPE with the transformers requirement,
    // not fork a second copy — two libvips builds in one tree is ~17MB of
    // duplicate native binaries and an ABI coin flip at load time.
    const lock = JSON.parse(
      readFileSync(join(repoRoot, 'package-lock.json'), 'utf-8'),
    ) as { packages?: Record<string, { version?: string }> };

    const versions = new Set<string>();
    for (const [path, meta] of Object.entries(lock.packages ?? {})) {
      if (path.endsWith('node_modules/sharp') && meta.version) versions.add(meta.version);
    }

    expect([...versions]).toHaveLength(1);
  });
});
