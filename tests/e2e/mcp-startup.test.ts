import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, it, expect, beforeAll } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const PKG_VERSION = (JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8')) as { version: string }).version;
const DIST_ENTRY = join(REPO_ROOT, 'dist', 'index.js');
const DIST_CONTROL = join(REPO_ROOT, 'dist', 'server', 'control.js');
const EXPECTED_TOOLS = [
  'fetch', 'search', 'crawl', 'cache', 'extract',
  'find_similar', 'research', 'agent', 'diff', 'watch',
];

type ProbeResult = { initializeMs: number; toolsListMs: number; tools: string[]; stderr: string; dataDirCreated: boolean };

function moduleTraceOptions(tracePath: string): string {
  const source = [
    "import { registerHooks } from 'node:module'",
    "import { appendFileSync } from 'node:fs'",
    `const trace = ${JSON.stringify(tracePath)}`,
    "registerHooks({ resolve(specifier, context, nextResolve) { const result = nextResolve(specifier, context); appendFileSync(trace, result.url + '\\n'); return result } })",
  ].join(';');
  return `--import=${new URL(`data:text/javascript,${encodeURIComponent(source)}`).href}`;
}

function assertFreshBuild(): void {
  const pairs = [
    ['src/index.ts', 'dist/index.js'],
    ['src/cli/mcp.ts', 'dist/cli/mcp.js'],
    ['src/server.ts', 'dist/server.js'],
    ['src/server/control.ts', 'dist/server/control.js'],
    ['tsup.config.ts', 'dist/server/control.js'],
  ] as const;
  for (const [source, output] of pairs) {
    const sourcePath = join(REPO_ROOT, source);
    const outputPath = join(REPO_ROOT, output);
    expect(existsSync(outputPath), `missing build output: ${output}`).toBe(true);
    expect(
      statSync(outputPath).mtimeMs,
      `stale build output: ${output} is older than ${source}; run npm run build`,
    ).toBeGreaterThanOrEqual(statSync(sourcePath).mtimeMs);
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timeout after ${timeoutMs}ms`)), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function closeMcp(client: Client, transport: StdioClientTransport): Promise<void> {
  try {
    await withTimeout(client.close(), 4500, 'MCP close');
  } catch (err) {
    await withTimeout(transport.close(), 5000, 'MCP transport cleanup');
    throw err;
  }
}

async function probeMcp(dataDir: string, extraEnv: Record<string, string> = {}): Promise<ProbeResult> {
  const client = new Client({ name: 'wigolo-stage-a-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [DIST_ENTRY, 'mcp'],
    cwd: REPO_ROOT,
    env: { WIGOLO_DATA_DIR: dataDir, LOG_LEVEL: 'info', ...extraEnv },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  try {
    const initializeStart = Date.now();
    await withTimeout(client.connect(transport), 5000, 'initialize');
    const initializeMs = Date.now() - initializeStart;
    const toolsStart = Date.now();
    const result = await withTimeout(client.listTools(), 500, 'tools/list');
    const toolsListMs = Date.now() - toolsStart;
    return {
      initializeMs,
      toolsListMs,
      tools: result.tools.map((tool) => tool.name),
      stderr,
      dataDirCreated: existsSync(dataDir),
    };
  } finally {
    await closeMcp(client, transport);
  }
}

describe('e2e: MCP server startup', () => {
  beforeAll(() => {
    expect(existsSync(DIST_ENTRY)).toBe(true);
    expect(existsSync(DIST_CONTROL)).toBe(true);
    assertFreshBuild();
  });

  it('keeps lightweight CLI paths prompt and free of the heavy runtime', () => {
    const commands = [
      { args: ['--version'], exitCode: 0, output: `wigolo ${PKG_VERSION}` },
      { args: ['--help'], exitCode: 0, output: /local-first web intelligence/i },
      { args: ['auth', 'status'], exitCode: 0, output: /Auth Configuration Status/ },
      { args: ['not-a-command'], exitCode: 1, output: /unknown command/i },
    ];
    for (const command of commands) {
      const root = mkdtempSync(join(tmpdir(), 'wigolo-cli-trace-'));
      const dataDir = join(root, 'data');
      const tracePath = join(root, 'modules.txt');
      try {
        const startedAt = Date.now();
        const result = spawnSync(process.execPath, [DIST_ENTRY, ...command.args], {
          cwd: REPO_ROOT,
          encoding: 'utf-8',
          timeout: 5000,
          env: {
            ...process.env,
            WIGOLO_DATA_DIR: dataDir,
            NODE_OPTIONS: moduleTraceOptions(tracePath),
          },
        });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(command.exitCode);
        const output = `${result.stdout}${result.stderr}`;
        if (typeof command.output === 'string') {
          expect(output).toContain(command.output);
        } else {
          expect(output).toMatch(command.output);
        }
        expect(Date.now() - startedAt).toBeLessThan(5000);
        expect(existsSync(dataDir)).toBe(false);
        const loaded = readFileSync(tracePath, 'utf-8').replaceAll('\\', '/');
        for (const marker of [
          '/server.js', '/cache/db.js', '/embedding/', '/fetch/browser-pool.js',
          '/fetch/browser-acquire.js', '/fetch/playwright-tier.js',
          '/plugins/', '/searxng/', '/tools/',
        ]) {
          expect(loaded).not.toContain(marker);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('completes initialize and tools/list without starting the runtime', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wigolo-stage-a-'));
    const dataDir = join(root, 'data');
    try {
      const result = await probeMcp(dataDir);
      expect(result.initializeMs).toBeLessThan(5000);
      expect(result.toolsListMs).toBeLessThan(500);
      expect(result.tools).toEqual(EXPECTED_TOOLS);
      expect(result.dataDirCreated).toBe(false);
      expect(result.stderr).not.toMatch(/loading embedding model|embedding provider verified/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not load heavy runtime modules during protocol discovery', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wigolo-module-trace-'));
    const dataDir = join(root, 'data');
    const tracePath = join(root, 'modules.txt');
    try {
      const result = await probeMcp(dataDir, {
        WIGOLO_MODULE_TRACE: tracePath,
        NODE_OPTIONS: moduleTraceOptions(tracePath),
      });
      expect(result.tools).toEqual(EXPECTED_TOOLS);
      const loaded = readFileSync(tracePath, 'utf-8').replaceAll('\\', '/');
      const forbidden = [
        '/cache/db.js', '/embedding/', '/fetch/browser', 'playwright-tier',
        '/plugins/', '/searxng/', '/tools/', '/daemon/proxy.js',
      ];
      for (const marker of forbidden) expect(loaded).not.toContain(marker);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps all 30 serial cold processes within the protocol budgets', async () => {
    const results: Array<ProbeResult | Error> = [];
    for (let index = 0; index < 30; index += 1) {
      const root = mkdtempSync(join(tmpdir(), 'wigolo-cold-'));
      const dataDir = join(root, 'data');
      try {
        results.push(await probeMcp(dataDir));
      } catch (err) {
        results.push(err instanceof Error ? err : new Error(String(err)));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
    const failures = results.filter((result): result is Error => result instanceof Error);
    const successes = results.filter((result): result is ProbeResult => !(result instanceof Error));
    expect(failures.map((failure) => failure.message)).toEqual([]);
    expect(successes).toHaveLength(30);
    expect(Math.max(...successes.map((result) => result.initializeMs))).toBeLessThan(5000);
    expect(Math.max(...successes.map((result) => result.toolsListMs))).toBeLessThan(500);
    for (const result of successes) {
      expect(result.tools).toEqual(EXPECTED_TOOLS);
      expect(result.dataDirCreated).toBe(false);
    }
  }, 180000);

  it('reports the package version through the official SDK initialization', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wigolo-version-'));
    try {
      const client = new Client({ name: 'version-test', version: '1.0.0' });
      const transport = new StdioClientTransport({ command: process.execPath, args: [DIST_ENTRY, 'mcp'], cwd: REPO_ROOT, env: { WIGOLO_DATA_DIR: join(root, 'data') }, stderr: 'pipe' });
      try {
        await withTimeout(client.connect(transport), 5000, 'initialize');
        expect(client.getServerVersion()?.version).toBe(PKG_VERSION);
      } finally {
        await closeMcp(client, transport);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
