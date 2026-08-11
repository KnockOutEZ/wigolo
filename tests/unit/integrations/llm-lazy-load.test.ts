/**
 * The four cloud-LLM SDKs are ~38.5 MiB of module graph. Core search, fetch,
 * crawl, extract and cache are keyless by design, and the extract path reaches
 * src/extraction/schema.ts -> llm-fallback.ts -> all four adapters, so a static
 * import loaded every vendor SDK at startup for users who never call a model.
 *
 * Two failure modes are guarded here, and they are NOT the same guard.
 *
 * 1. Regression to a static import. Cheap to catch, so it is caught by shape:
 *    no value-level static import of a vendor SDK anywhere in src/.
 *
 * 2. `import(variable)`. esbuild silently DROPS a dynamic import whose specifier
 *    is not a string literal. The result works in vitest and in `npm run dev`
 *    and fails only in the packaged binary — a green suite is not evidence
 *    about this class at all. So the specifiers are required to be literals
 *    here, and the bundle itself is checked by
 *    scripts/verify-llm-bundle-resolution.mjs (`npm run verify:llm-bundle`),
 *    which runs the bundled build with no node_modules at all.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import ts from 'typescript';

const repoRoot = join(__dirname, '..', '..', '..');
const srcRoot = join(repoRoot, 'src');

const VENDOR_SDKS = ['@anthropic-ai/sdk', 'openai', '@google/genai', 'groq-sdk'];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) out.push(full);
  }
  return out;
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, 'utf-8'), ts.ScriptTarget.Latest, true);
}

function packageRoot(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/**
 * Repo-relative path with POSIX separators on every platform.
 *
 * `join` yields backslashes on Windows, so the raw slice produced
 * `src\fetch\cdp-direct.ts` there while the exemption list below is keyed by
 * `src/fetch/cdp-direct.ts`. Every documented exemption then missed its key and
 * reported as an undocumented violation — the test failed on Windows for a path
 * separator rather than for anything about imports.
 */
function repoRelative(file: string): string {
  return file.slice(repoRoot.length + 1).split(sep).join('/');
}

interface StaticImport { file: string; specifier: string }
interface DynamicImport { file: string; literal: boolean; text: string }

const staticValueImports: StaticImport[] = [];
const dynamicImports: DynamicImport[] = [];

for (const file of sourceFiles(srcRoot)) {
  const source = parse(file);
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text;
      // `import type { … }` is erased at compile time and costs nothing at run time.
      const typeOnly = node.importClause?.isTypeOnly === true;
      if (!typeOnly && VENDOR_SDKS.includes(packageRoot(spec))) {
        staticValueImports.push({ file: repoRelative(file), specifier: spec });
      }
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [arg] = node.arguments;
      const literal = arg !== undefined && ts.isStringLiteral(arg);
      const text = literal ? (arg as ts.StringLiteral).text : arg?.getText(source) ?? '<none>';
      if (!literal || VENDOR_SDKS.includes(packageRoot(text))) {
        dynamicImports.push({ file: repoRelative(file), literal, text });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

describe('cloud LLM SDKs stay off the keyless startup path', () => {
  it('no src/ module statically imports a vendor SDK for its value', () => {
    expect(staticValueImports).toEqual([]);
  });

  it('scans a real tree rather than silently walking nothing', () => {
    // Without this, an empty or mis-rooted scan would make every other
    // assertion in the file pass by vacuum.
    expect(sourceFiles(srcRoot).length).toBeGreaterThan(200);
    const vendorDynamic = dynamicImports.filter((d) => d.literal);
    expect(vendorDynamic.length).toBeGreaterThanOrEqual(VENDOR_SDKS.length);
  });

  it('reaches every vendor SDK through a dynamic import', () => {
    const reached = new Set(dynamicImports.filter((d) => d.literal).map((d) => packageRoot(d.text)));
    for (const sdk of VENDOR_SDKS) expect([...reached]).toContain(sdk);
  });

  it('uses only literal specifiers, because esbuild drops import(variable)', () => {
    // This is the trap. A variable specifier type-checks, passes this suite and
    // passes `npm run dev`, then the module is simply absent from the packaged
    // binary.
    //
    // The repo has a documented escape hatch for optionalDependencies: a
    // specifier held as `string` rather than a literal so `tsc --noEmit`
    // skips resolution on installs where the package is legitimately missing
    // (`npm install --omit=optional`, no prebuilt binary for the platform).
    // Those sites already degrade to null or a typed error when the import
    // throws, so the bundler behaviour is accepted deliberately there.
    //
    // A REQUIRED dependency has no such excuse: it must resolve, so it must be
    // a literal. That is the line this test draws.
    const allowed = new Map([
      ['src/fetch/cdp-direct.ts', 'chrome-remote-interface'],
      ['src/fetch/stealth.ts', 'patchright'],
      ['src/fetch/tls-tier.ts', 'wreq-js'],
      ['src/plugins/loader.ts', 'a runtime plugin file URL, not a package'],
    ]);

    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8')) as {
      optionalDependencies?: Record<string, string>;
    };
    const optional = new Set(Object.keys(pkg.optionalDependencies ?? {}));

    const unexpected = dynamicImports
      .filter((d) => !d.literal && !allowed.has(d.file))
      .map((d) => `${d.file}: import(${d.text})`);
    expect(unexpected, 'non-literal dynamic import outside the documented exemptions').toEqual([]);

    // Every exemption must still MATCH a real scanned site. Without this the
    // exemption lookup can silently stop matching and the check above becomes
    // permissive in the wrong direction — which is precisely how this test
    // behaved on Windows, where `join` produced backslashes and every key
    // missed. A stale exemption (file renamed or deleted) fails here too.
    const nonLiteralFiles = new Set(
      dynamicImports.filter((d) => !d.literal).map((d) => d.file),
    );
    for (const key of allowed.keys()) {
      expect(
        nonLiteralFiles.has(key),
        `exemption "${key}" matched no scanned import site — stale entry, or the ` +
          `scanned path shape drifted (separator/rooting) and the exemption lookup is dead`,
      ).toBe(true);
    }

    // The exemption is only legitimate while those really are optional deps. If
    // one is promoted to a required dependency, the escape hatch stops being
    // justified and this fails rather than shipping a module the binary drops.
    for (const [file, target] of allowed) {
      if (file === 'src/plugins/loader.ts') continue;
      expect(optional.has(target), `${file} imports ${target}, which must stay optional`).toBe(true);
    }

    // No vendor SDK may ever use the escape hatch: all four are required deps.
    for (const d of dynamicImports.filter((x) => !x.literal)) {
      for (const sdk of VENDOR_SDKS) expect(d.text).not.toContain(sdk);
    }
  });
});
