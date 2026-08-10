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

  // The deadline must govern EVERY exit from the acquire loop, not just the sleeping one.
  // The stale-lock STEAL branch `continue`s without sleeping, so when the steal cannot
  // succeed the loop had no way out at all: it never threw, never slept, and — because the
  // loop is SYNCHRONOUS — no test timeout, signal handler or teardown could interrupt it.
  // That is the difference between a slow test and a wedged process: a wedged worker keeps
  // its parent's pipes open, so the whole run hangs rather than failing.
  //
  // Forced condition: a lock that (a) exists, so mkdir yields EEXIST; (b) is backdated, so it
  // reads as stale; and (c) sits in a read-only parent, so the rename-steal fails with EACCES
  // — which is NOT the EPERM the steal retries on, so it can never win. Runs in a CHILD
  // process precisely because a regression here blocks the event loop: an in-process
  // assertion would hang the suite instead of failing it.
  it.skipIf(process.platform === 'win32')(
    'throws instead of spinning forever when a stale lock can never be stolen',
    async () => {
      const { spawn } = await import('node:child_process');
      const { chmodSync, utimesSync } = await import('node:fs');
      const { fileURLToPath } = await import('node:url');
      const { dirname: dn } = await import('node:path');
      const here = dn(fileURLToPath(import.meta.url));
      const receiptsMod = join(here, '..', '..', '..', '..', '..', 'src', 'cli', 'agents', 'skills', 'receipts.ts');

      const skillsDir = join(tmpData, 'skills');
      const lockDir = join(skillsDir, 'receipts.lock');
      mkdirSync(lockDir, { recursive: true });
      writeFileSync(join(lockDir, 'owner'), 'never-releases', 'utf-8');
      const old = new Date(Date.now() - 60_000);
      utimesSync(lockDir, old, old);
      chmodSync(skillsDir, 0o500);

      const script = `
        import { pathToFileURL } from 'node:url';
        const { withReceiptsLock } = await import(pathToFileURL(${JSON.stringify(receiptsMod)}).href);
        try {
          withReceiptsLock((store) => ({ store, result: 1 }));
          process.stdout.write('ACQUIRED');
        } catch (e) {
          process.stdout.write('THREW:' + e.message);
        }
      `;

      const started = Date.now();
      const result = await new Promise<{ out: string; killed: boolean }>((resolve) => {
        const p = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
          env: {
            ...process.env,
            WIGOLO_DATA_DIR: tmpData,
            HOME: tmpHome,
            // Keep the guard cheap: the defect is the MISSING deadline check, not its value.
            WIGOLO_SKILLS_LOCK_TIMEOUT_MS: '400',
          },
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        let out = '';
        p.stdout.on('data', (d) => (out += String(d)));
        // Hard bound well above the 400ms deadline. A spinning child is killed here, and the
        // assertions below then fail on its empty output — a red, not a hung suite.
        const killer = setTimeout(() => p.kill('SIGKILL'), 6_000);
        p.on('exit', () => {
          clearTimeout(killer);
          resolve({ out, killed: Date.now() - started >= 6_000 });
        });
      });

      chmodSync(skillsDir, 0o700); // let afterEach clean up

      expect(result.out, 'child produced no verdict — it was still spinning when killed').toContain('THREW:');
      expect(result.out).toContain('timed out');
      expect(Date.now() - started, 'acquire must give up on its own deadline').toBeLessThan(5_000);
    },
    30_000
  );

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

  // Every child this describe spawns, so none can outlive its test.
  //
  // WHY this bookkeeping exists: the writers race under `Promise.all`, which settles on the
  // FIRST rejection while its siblings are still running — and nothing killed them. A survivor
  // is not merely untidy: its stderr is piped, so the vitest worker holds an open pipe and a
  // live child handle and can never exit. The run then HANGS instead of failing, which is a
  // symptom nobody can read off a test report. Two writers leaking two orphans is exactly the
  // shape of the unexplained ubuntu CI stall.
  let spawned: Array<import('node:child_process').ChildProcess> = [];

  function killSpawned(): void {
    for (const p of spawned) {
      try {
        p.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
    spawned = [];
  }

  afterEach(() => {
    killSpawned();
  });

  function tsxAvailable(): boolean {
    try {
      require.resolve('tsx/cli');
      return true;
    } catch {
      return false;
    }
  }

  async function spawnChild(body: string): Promise<{
    proc: import('node:child_process').ChildProcess;
    done: Promise<number>;
  }> {
    const { spawn } = await import('node:child_process');
    const p = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', body], {
      env: { ...process.env, WIGOLO_DATA_DIR: tmpData, HOME: tmpHome },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    spawned.push(p);
    // Belt and braces: a survivor must not be able to hold the runner open even in the window
    // before the sweep runs.
    p.unref();
    // spawn's stdio pipes are Sockets at runtime but are typed as Readable, which has no
    // unref. Socket#unref is the part that actually stops a PIPED stream holding the event
    // loop open — unref'ing the child alone does not release its stdio handles.
    (p.stderr as unknown as { unref?: () => void } | null)?.unref?.();
    const done = new Promise<number>((resolve, reject) => {
      let stderr = '';
      p.stderr?.on('data', (d) => (stderr += String(d)));
      p.on('error', reject);
      p.on('exit', (code) => (code === 0 ? resolve(0) : reject(new Error(`child exited ${code}: ${stderr}`))));
    });
    return { proc: p, done };
  }

  async function receiptsModPath(): Promise<string> {
    const { fileURLToPath } = await import('node:url');
    const { dirname: dn } = await import('node:path');
    const here = dn(fileURLToPath(import.meta.url));
    return join(here, '..', '..', '..', '..', '..', 'src', 'cli', 'agents', 'skills', 'receipts.ts');
  }

  it('no lost update: every key from both racing writers survives', async () => {
    // tsx is a devDependency — resolvable in any dev checkout. Fail loud rather
    // than silently passing if the environment can't spawn the racing child.
    expect(tsxAvailable(), 'tsx not resolvable — cannot run the lock-race test').toBe(true);

    const receiptsMod = await receiptsModPath();
    const keyBase = join(tmpHome, 'w');

    const child = async (writerId: number): Promise<number> => {
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
      const { done } = await spawnChild(script);
      return done;
    };

    await Promise.all(Array.from({ length: WRITERS }, (_, i) => child(i)));

    const { readReceipts } = await load();
    const store = readReceipts();
    // Every writer's every cycle must be present — no clobbering.
    for (let w = 0; w < WRITERS; w++) {
      for (let c = 0; c < CYCLES; c++) {
        expect(store[`${keyBase}${w}-c${c}`], `missing key from writer ${w} cycle ${c}`).toBeDefined();
      }
    }
  }, 30_000);

  // The forced condition for the leak itself: one writer dies immediately, its sibling never
  // exits on its own. `Promise.all` rejects the moment the first one fails, which is precisely
  // when the old code walked away from the survivor. Without the sweep the survivor outlives
  // the test, keeps a piped stderr open on the vitest worker, and the RUN hangs — so this is
  // asserted on a bounded wait rather than an `await once(proc, 'exit')`, which would itself
  // hang the suite on regression instead of failing it.
  it('a failed writer never leaves its sibling running', async () => {
    expect(tsxAvailable(), 'tsx not resolvable — cannot run the orphan-sweep test').toBe(true);

    const dies = await spawnChild(`process.exit(3);`);
    // A real timer, not `new Promise(() => {})` — a never-settling promise registers NOTHING on
    // the event loop, so node exits at once and the assertion below passes without ever having
    // had a survivor to sweep. That vacuity is what the sweep-disabled probe caught.
    const lingers = await spawnChild(`await new Promise((r) => setTimeout(r, 600_000));`);

    await expect(Promise.all([dies.done, lingers.done])).rejects.toThrow(/exited 3/);

    // The sibling is still running here — that is the leak the sweep exists to close.
    expect(lingers.proc.exitCode, 'sibling should still be running before the sweep').toBeNull();

    killSpawned();

    const died = await Promise.race([
      new Promise<boolean>((r) => lingers.proc.once('exit', () => r(true))),
      new Promise<boolean>((r) => setTimeout(() => r(false), 5_000)),
    ]);
    expect(died, 'sibling of a failed writer survived the sweep — it will wedge the runner').toBe(true);
  }, 30_000);
});
