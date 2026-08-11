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

  interface WriterOutcome {
    writerId: number;
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }

  async function spawnChild(
    body: string,
    envOverrides: Record<string, string> = {},
  ): Promise<{
    proc: import('node:child_process').ChildProcess;
    done: Promise<number>;
    settled: Promise<Omit<WriterOutcome, 'writerId'>>;
  }> {
    const { spawn } = await import('node:child_process');
    const p = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', body], {
      env: { ...process.env, WIGOLO_DATA_DIR: tmpData, HOME: tmpHome, ...envOverrides },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    spawned.push(p);
    // Belt and braces: a survivor must not be able to hold the runner open even in the window
    // before the sweep runs.
    p.unref();
    // spawn's stdio pipes are Sockets at runtime but are typed as Readable, which has no
    // unref. Socket#unref is the part that actually stops a PIPED stream holding the event
    // loop open — unref'ing the child alone does not release its stdio handles.
    (p.stdout as unknown as { unref?: () => void } | null)?.unref?.();
    (p.stderr as unknown as { unref?: () => void } | null)?.unref?.();

    let stdout = '';
    let stderr = '';
    p.stdout?.on('data', (d) => (stdout += String(d)));
    p.stderr?.on('data', (d) => (stderr += String(d)));

    const done = new Promise<number>((resolve, reject) => {
      p.on('error', reject);
      p.on('exit', (code) => (code === 0 ? resolve(0) : reject(new Error(`child exited ${code}: ${stderr}`))));
    });
    // `done` exists for the orphan-sweep test, which NEEDS an early rejection to catch its
    // sibling still running. Every other caller consumes `settled` instead, which would leave
    // `done` rejecting with nobody listening — an unhandled rejection that vitest reports as a
    // second, unrelated-looking failure. Attaching a handler here marks it handled without
    // changing what `done` settles to, so the sweep test's `.rejects` still works.
    void done.catch(() => {});

    // 'close' rather than 'exit': exit fires when the process is gone, which can be BEFORE its
    // piped stdout has been drained. A verdict assembled from a half-read report would blame
    // the child for saying nothing when it had in fact said everything.
    const settled = new Promise<Omit<WriterOutcome, 'writerId'>>((resolve) => {
      p.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    });

    return { proc: p, done, settled };
  }

  async function runWriter(
    writerId: number,
    body: string,
    envOverrides: Record<string, string> = {},
  ): Promise<WriterOutcome> {
    const { settled } = await spawnChild(body, envOverrides);
    return { writerId, ...(await settled) };
  }

  const CHILD_ENTRY = `{ scope: 'global', agents: ['claude-code'], packs: {}, installedAt: 'now' }`;

  /** A writer that does `cycles` honest read-mutate-write turns and reports what the lock accepted. */
  function writerScript(mod: string, keyBase: string, id: number, cycles: number): string {
    return `
      import { pathToFileURL } from 'node:url';
      const m = await import(pathToFileURL(${JSON.stringify(mod)}).href);
      const wrote = [];
      for (let i = 0; i < ${cycles}; i++) {
        const key = ${JSON.stringify(keyBase)} + ${id} + '-c' + i;
        m.withReceiptsLock((store) => {
          store[key] = ${CHILD_ENTRY};
          return { store, result: undefined };
        });
        // Pushed only AFTER the lock returned, so the report means "writes the lock told me
        // succeeded" — which is the only claim a lost-update verdict may be built on.
        wrote.push(key);
      }
      process.stdout.write(JSON.stringify({ receiptsPath: m.receiptsPath(), wrote }));
    `;
  }

  /**
   * Name the failure instead of leaving four causes wearing one face.
   *
   * A missing key used to be reported the same way whether the writer crashed, never ran,
   * wrote to a different store, or genuinely lost its update — and only the last of those is
   * about locking at all. (The windows CI red that prompted this WAS the first case: the child
   * died on an EPERM from the lock mkdir.) Order matters: a crashed writer's absent keys say
   * nothing about the lock, so the cheaper explanations must be excluded before the expensive
   * one is allowed to be named.
   *
   * Returns null when every writer's claim is consistent with the shared store.
   */
  function diagnoseWriters(
    outcomes: WriterOutcome[],
    store: Record<string, unknown>,
    parentReceiptsPath: string,
  ): string | null {
    for (const o of outcomes) {
      if (o.code !== 0) {
        const sig = o.signal ? ` (signal ${o.signal})` : '';
        return `CHILD_FAILED: writer ${o.writerId} exited ${o.code}${sig} — the writer died, so nothing here is evidence about locking. Child stderr:\n${o.stderr.trim()}`;
      }
    }

    const reports = new Map<number, { receiptsPath: string; wrote: string[] }>();
    for (const o of outcomes) {
      let report: { receiptsPath?: unknown; wrote?: unknown } | undefined;
      try {
        report = JSON.parse(o.stdout) as { receiptsPath?: unknown; wrote?: unknown };
      } catch {
        report = undefined;
      }
      const wrote = Array.isArray(report?.wrote) ? (report.wrote as string[]) : undefined;
      if (!wrote || wrote.length === 0 || typeof report?.receiptsPath !== 'string') {
        return `CHILD_SILENT: writer ${o.writerId} exited 0 without reporting a single completed write — it never ran the loop, so a missing key proves nothing. stdout=${JSON.stringify(o.stdout)} stderr=${JSON.stringify(o.stderr.trim())}`;
      }
      if (report.receiptsPath !== parentReceiptsPath) {
        return `STORE_DIVERGED: writer ${o.writerId} wrote to ${report.receiptsPath} but the assertions read ${parentReceiptsPath} — the child resolved a different store, which is an environment fault, not a lost update.`;
      }
      reports.set(o.writerId, { receiptsPath: report.receiptsPath, wrote });
    }

    for (const [id, r] of reports) {
      const missing = r.wrote.filter((k) => !(k in store));
      if (missing.length > 0) {
        return `LOST_UPDATE: writer ${id} reported ${r.wrote.length} writes accepted by the lock but ${missing.length} are absent from the shared store (first missing: ${missing[0]}) — the lock let a concurrent writer clobber them.`;
      }
    }
    return null;
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

    // Every writer is collected, not just the first to fail. `Promise.all` settled on the first
    // rejection and discarded whatever the sibling had to say — so a run where BOTH writers
    // died reported one of them, and the other's outcome was lost with it.
    const outcomes = await Promise.all(
      Array.from({ length: WRITERS }, (_, id) =>
        runWriter(id, writerScript(receiptsMod, keyBase, id, CYCLES)),
      ),
    );

    const { readReceipts, receiptsPath } = await load();
    const store = readReceipts();

    // Classify first: this narrows the DIAGNOSIS, never the guarantee. The per-key assertions
    // below are unchanged and still the contract — the verdict just gets to the cause before
    // they restate the symptom.
    expect(diagnoseWriters(outcomes, store, receiptsPath())).toBeNull();

    // Every writer's every cycle must be present — no clobbering.
    for (let w = 0; w < WRITERS; w++) {
      for (let c = 0; c < CYCLES; c++) {
        expect(store[`${keyBase}${w}-c${c}`], `missing key from writer ${w} cycle ${c}`).toBeDefined();
      }
    }
  }, 30_000);

  // The four probes below force each cause with a REAL child and assert the verdicts are
  // distinct. Without them "the test now says which failure it saw" is a claim about code
  // nobody has ever seen fire — and three of these four causes cannot be produced by waiting
  // for the race to misbehave on this platform.

  it('a writer that dies mid-run is named a child failure, not a lost update', async () => {
    expect(tsxAvailable(), 'tsx not resolvable').toBe(true);
    const receiptsMod = await receiptsModPath();
    const key = join(tmpHome, 'died');

    const outcome = await runWriter(
      0,
      `
        import { pathToFileURL } from 'node:url';
        const m = await import(pathToFileURL(${JSON.stringify(receiptsMod)}).href);
        m.withReceiptsLock((store) => { store[${JSON.stringify(key)}] = ${CHILD_ENTRY}; return { store, result: undefined }; });
        process.stderr.write('EPERM: operation not permitted, mkdir receipts.lock');
        process.exit(7);
      `,
    );

    const { readReceipts, receiptsPath } = await load();
    const verdict = diagnoseWriters([outcome], readReceipts(), receiptsPath());

    expect(verdict).toMatch(/^CHILD_FAILED: writer 0 exited 7/);
    // The child's own words must survive into the verdict — that stderr is the entire reason
    // the windows cause was identifiable at all.
    expect(verdict).toContain('EPERM: operation not permitted');
    expect(verdict).not.toContain('LOST_UPDATE');
  }, 30_000);

  it('a writer that exits clean without working is named silent, not a lost update', async () => {
    expect(tsxAvailable(), 'tsx not resolvable').toBe(true);

    // Exit 0 having done nothing: the one shape that survives an exit-code check and still
    // leaves every key missing. Reported as a lost update it would indict the lock for a
    // writer that never touched it.
    const outcome = await runWriter(0, `process.exit(0);`);

    const { readReceipts, receiptsPath } = await load();
    const verdict = diagnoseWriters([outcome], readReceipts(), receiptsPath());

    expect(verdict).toMatch(/^CHILD_SILENT: writer 0 exited 0 without reporting/);
    expect(verdict).not.toContain('LOST_UPDATE');
  }, 30_000);

  it('a writer that resolved a different store is named divergence, not a lost update', async () => {
    expect(tsxAvailable(), 'tsx not resolvable').toBe(true);
    const receiptsMod = await receiptsModPath();
    const keyBase = join(tmpHome, 'w');
    const otherData = join(tmpdir(), `wigolo-rcpt-other-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(otherData, { recursive: true });

    try {
      // Succeeds at everything it was asked to do — against the wrong data dir. Every key is
      // then absent from the store the assertions read, for a reason that has no bearing on
      // locking at all.
      const outcome = await runWriter(0, writerScript(receiptsMod, keyBase, 0, 3), {
        WIGOLO_DATA_DIR: otherData,
      });

      const { readReceipts, receiptsPath } = await load();
      const verdict = diagnoseWriters([outcome], readReceipts(), receiptsPath());

      expect(verdict).toMatch(/^STORE_DIVERGED: writer 0 wrote to /);
      expect(verdict).toContain(otherData);
      expect(verdict).not.toContain('LOST_UPDATE');
    } finally {
      rmSync(otherData, { recursive: true, force: true });
    }
  }, 30_000);

  it('a genuine clobber IS named a lost update — the verdict is not just a way to say no', async () => {
    expect(tsxAvailable(), 'tsx not resolvable').toBe(true);
    const receiptsMod = await receiptsModPath();
    const keyBase = join(tmpHome, 'w');

    // The must-fire half of the probe set. Three verdicts that only ever excuse the lock would
    // be a classifier that has quietly stopped being able to accuse it. Forced deterministically
    // rather than raced: writer 1 writes the store WITHOUT reading it first, which is exactly
    // what a broken lock lets a concurrent writer do.
    const w0 = await runWriter(0, writerScript(receiptsMod, keyBase, 0, 3));
    const w1 = await runWriter(
      1,
      `
        import { pathToFileURL } from 'node:url';
        const m = await import(pathToFileURL(${JSON.stringify(receiptsMod)}).href);
        const key = ${JSON.stringify(keyBase)} + '1-c0';
        m.writeReceipts({ [key]: ${CHILD_ENTRY} });
        process.stdout.write(JSON.stringify({ receiptsPath: m.receiptsPath(), wrote: [key] }));
      `,
    );

    const { readReceipts, receiptsPath } = await load();
    const verdict = diagnoseWriters([w0, w1], readReceipts(), receiptsPath());

    expect(verdict).toMatch(/^LOST_UPDATE: writer 0 reported 3 writes accepted by the lock but 3 are absent/);
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
