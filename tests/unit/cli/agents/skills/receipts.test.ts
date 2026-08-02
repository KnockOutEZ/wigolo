import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tmpHome: string;
let tmpData: string;
let tmpCwd: string;

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: vi.fn(() => tmpHome) };
});

vi.mock('../../../../../src/config.js', () => ({
  getConfig: vi.fn(() => ({ dataDir: tmpData })),
}));

async function load() {
  return import('../../../../../src/cli/agents/skills/receipts.js');
}

beforeEach(() => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  tmpHome = join(tmpdir(), `wigolo-rcpt-home-${stamp}`);
  tmpData = join(tmpdir(), `wigolo-rcpt-data-${stamp}`);
  tmpCwd = join(tmpdir(), `wigolo-rcpt-cwd-${stamp}`);
  mkdirSync(tmpHome, { recursive: true });
  mkdirSync(tmpData, { recursive: true });
  mkdirSync(tmpCwd, { recursive: true });
  vi.resetModules();
});

afterEach(() => {
  for (const d of [tmpHome, tmpData, tmpCwd]) rmSync(d, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('canonicalKey', () => {
  it('is stable on a fresh machine with no existing parent dirs (no mkdir)', async () => {
    const { canonicalKey } = await load();
    const dest = join(tmpCwd, 'nope', 'deeper', '.claude', 'skills', 'wigolo');
    const key = canonicalKey(dest);
    // Must not have created any of the missing dirs.
    expect(existsSync(join(tmpCwd, 'nope'))).toBe(false);
    // Key ends with the requested tail.
    expect(key.endsWith(join('skills', 'wigolo'))).toBe(true);
  });

  it('realpaths the nearest existing ancestor (symlink-resolved)', async () => {
    const { canonicalKey } = await load();
    const real = join(tmpCwd, '.claude', 'skills');
    mkdirSync(real, { recursive: true });
    const dest = join(real, 'wigolo', 'SKILL.md');
    const key = canonicalKey(dest);
    expect(key.endsWith(join('wigolo', 'SKILL.md'))).toBe(true);
  });
});

describe('isKeyWithinBounds — structural', () => {
  it('accepts a claude-code global pack dir', async () => {
    const { isKeyWithinBounds } = await load();
    const key = join(tmpHome, '.claude', 'skills', 'wigolo');
    expect(isKeyWithinBounds(key, tmpCwd, tmpHome)).toBe(true);
  });

  it('accepts a windsurf project owned rules file', async () => {
    const { isKeyWithinBounds } = await load();
    const key = join(tmpCwd, '.windsurf', 'rules', 'wigolo.md');
    expect(isKeyWithinBounds(key, tmpCwd, tmpHome)).toBe(true);
  });

  it('rejects an arbitrary path outside the targets shape', async () => {
    const { isKeyWithinBounds } = await load();
    expect(isKeyWithinBounds(join(tmpHome, 'evil', 'passwd'), tmpCwd, tmpHome)).toBe(false);
    // The skill-dirs BASE itself (no pack segment) is out of bounds.
    expect(isKeyWithinBounds(join(tmpHome, '.claude', 'skills'), tmpCwd, tmpHome)).toBe(false);
  });

  it('rejects a system path a malicious receipt might claim', async () => {
    const { isKeyWithinBounds } = await load();
    expect(isKeyWithinBounds('/etc/passwd', tmpCwd, tmpHome)).toBe(false);
  });
});

describe('readReceipts — corruption + validation', () => {
  it('corrupt JSON ⇒ empty store (fail-safe, never throws)', async () => {
    const { readReceipts, receiptsPath } = await load();
    mkdirSync(join(tmpData, 'skills'), { recursive: true });
    writeFileSync(receiptsPath(), '{ not valid json', 'utf-8');
    expect(readReceipts()).toEqual({});
  });

  it('drops entries with a non-absolute key', async () => {
    const { readReceipts, receiptsPath } = await load();
    mkdirSync(join(tmpData, 'skills'), { recursive: true });
    writeFileSync(
      receiptsPath(),
      JSON.stringify({
        'relative/key': { scope: 'global', agents: ['x'], packs: {}, installedAt: 'now' },
      }),
      'utf-8',
    );
    expect(readReceipts()).toEqual({});
  });

  it('drops entries whose receipt relPath contains ../ traversal', async () => {
    const { readReceipts, receiptsPath } = await load();
    mkdirSync(join(tmpData, 'skills'), { recursive: true });
    const key = join(tmpHome, '.claude', 'skills', 'wigolo');
    writeFileSync(
      receiptsPath(),
      JSON.stringify({
        [key]: {
          scope: 'global',
          agents: ['claude-code'],
          packs: { wigolo: { version: '1', files: { '../escape.md': 'abc' } } },
          installedAt: 'now',
        },
      }),
      'utf-8',
    );
    expect(readReceipts()).toEqual({});
  });

  it('keeps a well-formed absolute-key entry', async () => {
    const { readReceipts, receiptsPath } = await load();
    mkdirSync(join(tmpData, 'skills'), { recursive: true });
    const key = join(tmpHome, '.claude', 'skills', 'wigolo');
    const entry = {
      scope: 'global' as const,
      agents: ['claude-code'],
      packs: { wigolo: { version: '1', files: { 'SKILL.md': 'abc' } } },
      installedAt: 'now',
    };
    writeFileSync(receiptsPath(), JSON.stringify({ [key]: entry }), 'utf-8');
    const store = readReceipts();
    expect(store[key]).toBeDefined();
    expect(store[key].packs.wigolo.version).toBe('1');
  });
});

describe('withReceiptsLock — atomic read-merge-write', () => {
  it('persists mutations and round-trips through the store', async () => {
    const { withReceiptsLock, readReceipts } = await load();
    const key = join(tmpHome, '.claude', 'skills', 'wigolo');
    withReceiptsLock((store) => {
      store[key] = {
        scope: 'global',
        agents: ['claude-code'],
        packs: { wigolo: { version: '2', files: { 'SKILL.md': 'h' } } },
        installedAt: 'now',
      };
      return { store, result: undefined };
    });
    expect(readReceipts()[key].packs.wigolo.version).toBe('2');
  });

  it('two sequential lock cycles do not lose the earlier update', async () => {
    const { withReceiptsLock, readReceipts } = await load();
    const kA = join(tmpHome, '.claude', 'skills', 'a');
    const kB = join(tmpHome, '.claude', 'skills', 'b');
    withReceiptsLock((s) => {
      s[kA] = { scope: 'global', agents: ['claude-code'], packs: {}, installedAt: 'now' };
      return { store: s, result: undefined };
    });
    withReceiptsLock((s) => {
      s[kB] = { scope: 'global', agents: ['claude-code'], packs: {}, installedAt: 'now' };
      return { store: s, result: undefined };
    });
    const store = readReceipts();
    expect(store[kA]).toBeDefined();
    expect(store[kB]).toBeDefined();
  });

  it('steals a crash-orphaned stale lock and still writes', async () => {
    const { withReceiptsLock, readReceipts } = await load();
    // Simulate a crashed process that left a lock dir with an old mtime.
    const lockDir = join(tmpData, 'skills', 'receipts.lock');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, 'owner'), 'dead-pid', 'utf-8');
    // Backdate mtime beyond the timeout.
    const { utimesSync } = await import('node:fs');
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockDir, old, old);

    const key = join(tmpHome, '.claude', 'skills', 'wigolo');
    withReceiptsLock((s) => {
      s[key] = { scope: 'global', agents: ['claude-code'], packs: {}, installedAt: 'now' };
      return { store: s, result: undefined };
    });
    expect(readReceipts()[key]).toBeDefined();
  });

  it('atomic write leaves no .tmp turds', async () => {
    const { withReceiptsLock } = await load();
    withReceiptsLock((s) => ({ store: s, result: undefined }));
    const dir = join(tmpData, 'skills');
    const files = existsSync(dir) ? readFileSync : null;
    void files;
    const { readdirSync } = await import('node:fs');
    const leftover = readdirSync(dir).filter((f) => f.includes('.tmp-'));
    expect(leftover).toEqual([]);
  });
});

// F17 — genuine cross-process contention on the same receipts file. Two child
// processes each perform many read-mutate-write cycles under the real lock; a
// lost update (broken locking) would drop one writer's keys. Uses `--import tsx`
// resolved from the repo's node_modules so the child runs the real TS module.
describe('withReceiptsLock — concurrent cross-process writers (F17)', () => {
  const WRITERS = 2;
  const CYCLES = 25;

  function tsxAvailable(): boolean {
    try {
      require.resolve('tsx/cli');
      return true;
    } catch {
      return false;
    }
  }

  it('no lost update: every key from both racing writers survives', async () => {
    // tsx is a devDependency — resolvable in any dev checkout. Fail loud rather
    // than silently passing if the environment can't spawn the racing child.
    expect(tsxAvailable(), 'tsx not resolvable — cannot run the lock-race test').toBe(true);

    const { spawn } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const { dirname: dn } = await import('node:path');
    const here = dn(fileURLToPath(import.meta.url));
    // Resolve the receipts module absolute path for the child to import.
    const receiptsMod = join(here, '..', '..', '..', '..', '..', 'src', 'cli', 'agents', 'skills', 'receipts.ts');

    const child = (writerId: number): Promise<number> =>
      new Promise((resolve, reject) => {
        const keyBase = join(tmpHome, 'w');
        const script = `
          import { pathToFileURL } from 'node:url';
          const { withReceiptsLock } = await import(pathToFileURL(${JSON.stringify(receiptsMod)}).href);
          const id = ${writerId};
          for (let i = 0; i < ${CYCLES}; i++) {
            withReceiptsLock((store) => {
              store[${JSON.stringify(keyBase)} + id + '-c' + i] = { scope: 'global', agents: ['claude-code'], packs: {}, installedAt: 'now' };
              return { store, result: undefined };
            });
          }
        `;
        const p = spawn(
          process.execPath,
          ['--import', 'tsx', '--input-type=module', '-e', script],
          {
            env: { ...process.env, WIGOLO_DATA_DIR: tmpData, HOME: tmpHome },
            stdio: ['ignore', 'ignore', 'pipe'],
          },
        );
        let stderr = '';
        p.stderr.on('data', (d) => (stderr += String(d)));
        p.on('error', reject);
        p.on('exit', (code) => (code === 0 ? resolve(0) : reject(new Error(`writer ${writerId} exited ${code}: ${stderr}`))));
      });

    await Promise.all(Array.from({ length: WRITERS }, (_, i) => child(i)));

    const { readReceipts } = await load();
    const store = readReceipts();
    const keyBase = join(tmpHome, 'w');
    // Every writer's every cycle must be present — no clobbering.
    for (let w = 0; w < WRITERS; w++) {
      for (let c = 0; c < CYCLES; c++) {
        expect(store[`${keyBase}${w}-c${c}`], `missing key from writer ${w} cycle ${c}`).toBeDefined();
      }
    }
  }, 30_000);
});
