import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
// @ts-expect-error — plain-JS build tooling, deliberately not part of the typed src/ graph.
import { artifactName, archiveExt, binaryRelPath, parseVersionFile, splitTarget, versionFile, PACKAGE_JSON_MIRRORS, APP_ANCHOR_REL, SIZE_BUDGET } from '../../../scripts/binary/layout.mjs';
// @ts-expect-error — plain-JS build tooling, deliberately not part of the typed src/ graph.
import { checkSizeBudget, sizeBudgetFailure } from '../../../scripts/binary/size.mjs';
// @ts-expect-error — plain-JS build tooling, deliberately not part of the typed src/ graph.
import { EXTERNALS, resolveClosure, trimOnnxruntime } from '../../../scripts/binary/sidecar.mjs';
// @ts-expect-error — plain-JS build tooling, deliberately not part of the typed src/ graph.
import { auditBundleImports } from '../../../scripts/binary/build.mjs';
// @ts-expect-error — plain-JS build tooling, deliberately not part of the typed src/ graph.
import { readManifest, REPO_ROOT } from '../../../scripts/binary/manifest.mjs';

/*
 * Offline arms for the compile pipeline. Everything here runs without a network and without a
 * 120 MB build: the decisions are pure, and a decision that can only be checked by building the
 * artifact is a decision nobody checks. The build itself is exercised end-to-end by
 * `tests/integration/binary-artifact.test.ts`, which is opt-in for exactly that reason.
 */

const MANIFEST = readManifest();

const scratch: string[] = [];
function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `wigolo-bin-${prefix}-`));
  scratch.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

describe('mini-spec §4 artifact naming', () => {
  it('spells the archive exactly as install.sh and the brew formula will parse it', () => {
    expect(artifactName('0.2.1', 'darwin-arm64')).toBe('wigolo-0.2.1-darwin-arm64.tar.gz');
    expect(artifactName('1.0.0', 'linux-x64')).toBe('wigolo-1.0.0-linux-x64.tar.gz');
  });

  it('uses zip on win32, because that is what the destination OS can unpack unaided', () => {
    expect(archiveExt('win32')).toBe('zip');
    expect(artifactName('0.2.1', 'win32-x64')).toBe('wigolo-0.2.1-win32-x64.zip');
    expect(binaryRelPath('win32')).toBe('bin/wigolo.exe');
    expect(binaryRelPath('linux')).toBe('bin/wigolo');
  });

  it('keeps the §1 platform spelling — `win32`/`darwin`, never node`s download spelling', () => {
    // The build translates to nodejs.org's `win` internally; the CONTRACT must not, because a
    // consumer that computes the asset name from `process.platform` would miss it.
    for (const target of MANIFEST.targets as string[]) {
      const { platform, arch } = splitTarget(target);
      expect(artifactName('9.9.9', target)).toContain(`-${platform}-${arch}.`);
    }
  });

  it('refuses a target it cannot split rather than inventing an arch', () => {
    expect(() => splitTarget('darwin')).toThrow(/must be <platform>-<arch>/);
  });
});

describe('VERSION — mini-spec §4 G5', () => {
  const text = versionFile({ semver: '0.2.1', target: 'darwin-arm64', manifest: MANIFEST });

  it('puts semver first so a consumer that reads only line 1 still gets the contract field', () => {
    expect(text.split('\n')[0]).toBe('semver=0.2.1');
  });

  it('carries the toolchain, runtime, ABI and target the §4 layout promises', () => {
    const parsed = parseVersionFile(text);
    expect(parsed).toMatchObject({
      semver: '0.2.1',
      target: 'darwin-arm64',
      platform: 'darwin',
      arch: 'arm64',
      toolchain: 'node-sea',
      runtime: MANIFEST.runtime.kind,
      runtimeVersion: MANIFEST.runtime.version,
      abi: MANIFEST.runtime.abi,
    });
  });

  it('is readable by `grep | cut`, which is the only parser install.sh and brew have', () => {
    // Not a stylistic assertion. Two of the three named consumers are shell, so a format they
    // cannot read makes G5 ("a consumer can assert it") false by construction.
    for (const line of text.trim().split('\n')) expect(line).toMatch(/^[a-zA-Z]+=[^\s]*$/);
  });

  it('records no build timestamp, so two builds of one commit stay comparable', () => {
    expect(versionFile({ semver: '0.2.1', target: 'linux-x64', manifest: MANIFEST })).toBe(
      versionFile({ semver: '0.2.1', target: 'linux-x64', manifest: MANIFEST })
    );
  });
});

describe('§7 size budget', () => {
  const terms = [
    { name: 'bin', bytes: 118_000_000 },
    { name: '@huggingface/transformers', bytes: 46_000_000 },
    { name: 'onnxruntime-node', bytes: 552_000_000 },
  ];

  it('passes an artifact inside both axes', () => {
    const v = checkSizeBudget({ compressedBytes: 127_000_000, unpackedBytes: 405_000_000, terms });
    expect(v.ok).toBe(true);
    expect(sizeBudgetFailure(v)).toBeNull();
  });

  it('breaches on compressed alone, and names the largest term', () => {
    const v = checkSizeBudget({ compressedBytes: 449_060_094, unpackedBytes: 405_000_000, terms });
    expect(v.ok).toBe(false);
    expect(v.breaches.map((b: { axis: string }) => b.axis)).toEqual(['compressed']);
    const msg = sizeBudgetFailure(v) as string;
    expect(msg).toContain('onnxruntime-node');
    expect(msg).toContain('DECISIONS-AUTO');
  });

  it('breaches on unpacked alone — an artifact can pass one axis and blow the other', () => {
    const v = checkSizeBudget({ compressedBytes: 100_000_000, unpackedBytes: 1_133_000_000, terms });
    expect(v.ok).toBe(false);
    expect(v.breaches.map((b: { axis: string }) => b.axis)).toEqual(['unpacked']);
  });

  it('reports both axes when both breach, rather than stopping at the first', () => {
    const v = checkSizeBudget({ compressedBytes: 449_000_000, unpackedBytes: 1_133_000_000, terms });
    expect(v.breaches.map((b: { axis: string }) => b.axis)).toEqual(['compressed', 'unpacked']);
  });

  it('holds DR-5s numbers, so a quiet edit to the budget is a diff on this line', () => {
    expect(SIZE_BUDGET.compressedBytes).toBe(200 * 1000 * 1000);
    expect(SIZE_BUDGET.unpackedBytes).toBe(500 * 1000 * 1000);
  });
});

describe('bundle import audit — the two gates esbuild will not give you', () => {
  const meta = (imports: Array<{ path: string; kind: string }>) => ({ outputs: { 'out.cjs': { imports } } });

  it('passes a lowered bundle', () => {
    const audit = auditBundleImports(meta([
      { path: 'sharp', kind: 'require-call' },
      { path: 'node:fs', kind: 'require-call' },
    ]), ['sharp']);
    expect(audit).toEqual({ dynamic: [], missing: [] });
  });

  it('catches a SURVIVING dynamic import — the loud failure', () => {
    const audit = auditBundleImports(meta([
      { path: 'sharp', kind: 'dynamic-import' },
      { path: 'fastembed', kind: 'dynamic-import' },
    ]), ['sharp']);
    expect(audit.dynamic).toEqual(['fastembed', 'sharp']);
  });

  it('catches a DROPPED specifier — the silent failure a survivor count cannot see', () => {
    // This is the shape `import(SOME_VARIABLE)` produces: the bundler emits no import at all,
    // no warning at any log level, and the capability is simply absent from the binary. A gate
    // that only counted survivors would call this bundle clean.
    const audit = auditBundleImports(meta([{ path: 'sharp', kind: 'require-call' }]), ['sharp', 'wreq-js']);
    expect(audit.dynamic).toEqual([]);
    expect(audit.missing).toEqual(['wreq-js']);
  });
});

describe('sidecar closure', () => {
  /** A miniature `node_modules` with the exact shape that broke the first build. */
  function fixture(): string {
    const root = tmp('closure');
    const write = (rel: string, json: unknown) => {
      const dir = join(root, rel);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'package.json'), JSON.stringify(json));
    };
    write('node_modules/tar', { name: 'tar', version: '6.2.1' });
    write('node_modules/leaf', { name: 'leaf', version: '1.0.0', dependencies: { tar: '^6' } });
    write('node_modules/other', { name: 'other', version: '1.0.0', dependencies: { tar: '^7' } });
    write('node_modules/other/node_modules/tar', { name: 'tar', version: '7.5.16' });
    return root;
  }

  it('keeps BOTH copies of a package npm resolved at two versions', () => {
    const { packages, missing } = resolveClosure({ repoRoot: fixture(), roots: ['leaf', 'other'] });
    expect(missing).toEqual([]);
    const tars = packages.filter((p: { name: string }) => p.name === 'tar');
    expect(tars.map((p: { rel: string; version: string }) => [p.rel, p.version]).sort()).toEqual([
      [join('node_modules', 'other', 'node_modules', 'tar'), '7.5.16'],
      [join('node_modules', 'tar'), '6.2.1'],
    ]);
  });

  it('records each package by its position in the tree, not by its name', () => {
    // The staging step replays `rel` verbatim under `libexec/`. Flattening to the name is what
    // let a nested tar@7 shadow the hoisted tar@6 that fastembed resolves, which killed
    // embeddings inside the artifact with a green build.
    const { packages } = resolveClosure({ repoRoot: fixture(), roots: ['other'] });
    for (const pkg of packages) expect(pkg.rel.startsWith('node_modules')).toBe(true);
  });

  it('refuses a closure with a missing REQUIRED dependency, naming who wanted it', () => {
    const root = tmp('missing');
    mkdirSync(join(root, 'node_modules', 'leaf'), { recursive: true });
    writeFileSync(
      join(root, 'node_modules', 'leaf', 'package.json'),
      JSON.stringify({ name: 'leaf', version: '1.0.0', dependencies: { gone: '^1' } })
    );
    const { missing } = resolveClosure({ repoRoot: root, roots: ['leaf'] });
    expect(missing).toEqual(['gone (required by leaf)']);
  });

  it('lets an ABSENT optional dependency pass — `sharp` declares one per platform', () => {
    const root = tmp('optional');
    mkdirSync(join(root, 'node_modules', 'leaf'), { recursive: true });
    writeFileSync(
      join(root, 'node_modules', 'leaf', 'package.json'),
      JSON.stringify({ name: 'leaf', version: '1.0.0', optionalDependencies: { 'leaf-linux-x64': '^1' } })
    );
    expect(resolveClosure({ repoRoot: root, roots: ['leaf'] }).missing).toEqual([]);
  });

  it('follows an INSTALLED peer dependency — `ink` needs `react` and only declares it as a peer', () => {
    const root = tmp('peer');
    const write = (rel: string, json: unknown) => {
      mkdirSync(join(root, rel), { recursive: true });
      writeFileSync(join(root, rel, 'package.json'), JSON.stringify(json));
    };
    write('node_modules/inkish', { name: 'inkish', version: '1.0.0', peerDependencies: { reactish: '*' } });
    write('node_modules/reactish', { name: 'reactish', version: '19.0.0' });
    const { packages } = resolveClosure({ repoRoot: root, roots: ['inkish'] });
    expect(packages.map((p: { name: string }) => p.name).sort()).toEqual(['inkish', 'reactish']);
  });

  it('declares every external with a reason, and marks the one that is never installed', () => {
    const names = EXTERNALS.map((e: { name: string }) => e.name);
    expect(names).toHaveLength(16);
    expect(names).toContain('ink');
    expect(names).toContain('yoga-layout');
    const tla = EXTERNALS.filter((e: { reason: string }) => e.reason === 'top-level-await');
    // Not a style check: these two hard-ERROR a CJS bundle, so the entry's no-TLA invariant
    // (src/index.ts) has to cover the dependency closure and not just the entry.
    expect(tla.map((e: { name: string }) => e.name)).toEqual(['ink', 'yoga-layout']);
  });
});

describe('onnxruntime trim', () => {
  function ortFixture(pairs: Array<[string, string]>, extraFiles: string[] = []): string {
    const root = tmp('ort');
    for (const [platform, arch] of pairs) {
      const dir = join(root, 'libexec', 'node_modules', 'onnxruntime-node', 'bin', 'napi-v3', platform, arch);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'onnxruntime_binding.node'), 'x'.repeat(100));
      for (const f of extraFiles) writeFileSync(join(dir, f), 'y'.repeat(1000));
    }
    return root;
  }

  it('keeps the host pair and removes every other platform and arch', () => {
    const root = ortFixture([['darwin', 'arm64'], ['darwin', 'x64'], ['linux', 'x64'], ['win32', 'x64']]);
    const result = trimOnnxruntime({ stageRoot: root, target: 'darwin-arm64' });
    const napi = join(root, 'libexec', 'node_modules', 'onnxruntime-node', 'bin', 'napi-v3');
    expect(readdirSync(napi)).toEqual(['darwin']);
    expect(readdirSync(join(napi, 'darwin'))).toEqual(['arm64']);
    expect(result.removed.length).toBe(3);
  });

  it('removes the CUDA and TensorRT providers — 327 MB of hardware this artifact never sees', () => {
    const root = ortFixture([['linux', 'x64']], [
      'libonnxruntime_providers_cuda.so',
      'libonnxruntime_providers_tensorrt.so',
      'libonnxruntime_providers_shared.so',
    ]);
    trimOnnxruntime({ stageRoot: root, target: 'linux-x64' });
    const dir = join(root, 'libexec', 'node_modules', 'onnxruntime-node', 'bin', 'napi-v3', 'linux', 'x64');
    expect(readdirSync(dir).sort()).toEqual(['libonnxruntime_providers_shared.so', 'onnxruntime_binding.node']);
  });

  it('REFUSES to trim when the pair it would keep is absent', () => {
    // Same refusal `scripts/prune/ort-platforms.mjs` opens with. Without the host pair we cannot
    // tell "already trimmed" from "laid out differently", and in the second case every removal
    // candidate might be the one that gets loaded.
    const root = ortFixture([['linux', 'x64']]);
    const result = trimOnnxruntime({ stageRoot: root, target: 'darwin-arm64' });
    expect(result.removed).toEqual([]);
    expect(result.reason).toMatch(/refusing to trim/);
    expect(existsSync(join(root, 'libexec', 'node_modules', 'onnxruntime-node', 'bin', 'napi-v3', 'linux', 'x64'))).toBe(true);
  });
});

/*
 * THE EIGHTH-SITE GUARD.
 *
 * Seven places in `src/` read the package version by walking up from `import.meta.url`, at
 * three different dist depths, and the build mirrors `package.json` at exactly those three. The
 * mirror is ENUMERATIVE, so a new reader at a fourth depth finds nothing — and three of the
 * seven swallow that in a `catch` and answer `'0.0.0'`. During the spike that shipped
 * `serverInfo.version: "0.0.0"` to every MCP client from a binary whose `--version` was right.
 *
 * The guard is keyed on the FILE, not on the expression, so a new reader written in a shape
 * this test's matcher does not recognise still reds. Recognising it is a bonus; noticing it is
 * the job.
 */
describe('package.json self-readers stay at a mirrored depth', () => {
  const SRC = join(REPO_ROOT, 'src');

  /** Depth 1..3 correspond to the three mirrored copies; see layout.mjs PACKAGE_JSON_MIRRORS. */
  const KNOWN: Record<string, number> = {
    'server.ts': 1,
    'cli/help.ts': 2,
    'cli/status.ts': 2,
    'cli/tui/version.ts': 3,
    'cli/agents/utils.ts': 3,
    'daemon/rest/openapi.ts': 3,
    'telemetry/envelope.ts': 2,
  };

  /**
   * Files that read a package.json belonging to somebody ELSE — a plugin directory, an acquired
   * driver, a user-supplied path. Those are runtime paths, not dist depths, and the mirror has
   * nothing to do with them.
   */
  const RUNTIME_READERS = new Set([
    'plugins/loader.ts',
    'cli/plugin.ts',
    'cli/warmup.ts',
    'cli/doctor.ts',
    'fetch/browser-driver.ts',
    'fetch/driver-acquire.ts',
  ]);

  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...sourceFiles(p));
      else if (/\.tsx?$/.test(entry.name)) out.push(p);
    }
    return out;
  }

  /**
   * Every non-comment line that mentions a `package.json`.
   *
   * DELIBERATELY NOT narrowed to `readFileSync(`/`join(` and friends. A first version of this
   * guard did exactly that and then failed its own mutation test: a probe reader written with
   * aliased imports (`__rf(__j(here, '..', ...))`) mentioned `package.json`, read it, and
   * matched none of the names, so the guard reported seven readers and stayed green. Whether a
   * line is a READ is the narrow question; whether a file TOUCHES the name at all is the one
   * this guard can answer without being out-thought.
   */
  function readerLines(text: string): string[] {
    return text
      .split('\n')
      .filter((line) => /package\.json/.test(line))
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
  }

  const found = new Map<string, string[]>();
  for (const file of sourceFiles(SRC)) {
    const lines = readerLines(readFileSync(file, 'utf8'));
    if (lines.length > 0) found.set(relative(SRC, file).split('\\').join('/'), lines);
  }

  it('finds no self-reader outside the seven the mirror was built for', () => {
    const selfReaders = [...found.keys()].filter((f) => !RUNTIME_READERS.has(f)).sort();
    expect(selfReaders).toEqual(Object.keys(KNOWN).sort());
  });

  it('reads at depth 1, 2 or 3 — the depths libexec/app actually mirrors', () => {
    const mirroredDepths = new Set(
      (PACKAGE_JSON_MIRRORS as string[]).map((rel) => (rel === 'package.json' ? 3 : rel.split('/').length - 1))
    );
    expect([...mirroredDepths].sort()).toEqual([1, 2, 3]);
    for (const depth of Object.values(KNOWN)) expect(mirroredDepths.has(depth)).toBe(true);
  });

  it('measures each known reader`s depth from its own source, so a moved file reds', () => {
    for (const [file, expected] of Object.entries(KNOWN)) {
      const text = readFileSync(join(SRC, file), 'utf8');
      // Two shapes exist: a single relative string (`require('../../package.json')`) and a join
      // over '..' arguments, possibly inside a `packageRoot()` helper in the same file.
      const literal = text.match(/['"](?:\.\.\/)+package\.json['"]/)?.[0];
      const depth = literal
        ? (literal.match(/\.\.\//g) ?? []).length
        : (text.match(/join\(\s*here\s*,\s*((?:'\.\.'\s*,?\s*)*)/)?.[1]?.match(/'\.\.'/g) ?? []).length;
      expect({ file, depth }).toEqual({ file, depth: expected });
    }
  });

  it('anchors the bundle deep enough that all three walks land inside the mirror', () => {
    // `libexec/app/dist/cli/tui/__bundle.cjs` — four segments below the app root, so '..',
    // '../..' and '../../..' hit `dist/cli`, `dist` and the app root respectively.
    const segments = (APP_ANCHOR_REL as string).split('/');
    expect(segments.slice(0, 2)).toEqual(['libexec', 'app']);
    expect(segments.length - 3).toBe(3);
  });
});

describe('the SEA shims are a matched pair', () => {
  const seaDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'scripts', 'binary', 'sea');

  it('opens the wrapper in the banner and closes it in the footer', () => {
    const banner = readFileSync(join(seaDir, 'banner.js'), 'utf8');
    const footer = readFileSync(join(seaDir, 'footer.js'), 'utf8');
    expect(banner.trimEnd().endsWith('(function (require, __filename, __dirname) {')).toBe(true);
    expect(footer).toContain('})(__wigoloRequire, __wigoloAnchor, __wigoloAnchorDir);');
  });

  it('roots the sidecar at the executable`s REALPATH, which is what makes a symlink work', () => {
    // `process.execPath` is the path the process was invoked BY. install.sh puts a symlink on
    // PATH, and its parent contains no `libexec` at all — so this one call is the difference
    // between a working install and a binary that cannot find a single native.
    const banner = readFileSync(join(seaDir, 'banner.js'), 'utf8');
    expect(banner).toMatch(/realpathSync\(process\.execPath\)/);
    expect(banner).not.toMatch(/dirname\(process\.execPath\)/);
  });
});
