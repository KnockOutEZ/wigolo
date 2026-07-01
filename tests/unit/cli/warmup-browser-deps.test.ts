import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../src/cli/tui/run-command.js', () => ({
  runCommand: vi.fn(),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
    readFileSync: vi.fn(),
    rmSync: vi.fn(),
  };
});

// launch() default resolves to a clean-closing browser. Individual tests
// override chromium.launch to simulate a launch failure (missing OS libs).
vi.mock('playwright', () => {
  const okLaunch = () => Promise.resolve({ close: () => Promise.resolve() });
  return {
    chromium: { executablePath: vi.fn(() => '/fake/playwright/chromium/chrome'), launch: vi.fn(okLaunch) },
    firefox: { executablePath: vi.fn(() => '/fake/playwright/firefox/firefox'), launch: vi.fn(okLaunch) },
    webkit: { executablePath: vi.fn(() => '/fake/playwright/webkit/webkit'), launch: vi.fn(okLaunch) },
  };
});

vi.mock('../../../src/searxng/bootstrap.js', () => ({
  checkPythonAvailable: vi.fn().mockReturnValue(false),
  bootstrapNativeSearxng: vi.fn(),
  getBootstrapState: vi.fn().mockReturnValue({ status: 'ready', searxngPath: '/tmp/searxng' }),
}));

vi.mock('../../../src/python-env.js', () => ({
  checkVenvModule: vi.fn(() => ({ available: true })),
  venvInstallHint: () => 'hint',
}));

vi.mock('../../../src/config.js', () => ({
  getConfig: vi.fn(() => ({ dataDir: '/tmp/test-wigolo' })),
}));

import { chromium } from 'playwright';
import { runCommand } from '../../../src/cli/tui/run-command.js';
import { runWarmup } from '../../../src/cli/warmup.js';
import type { WarmupReporter } from '../../../src/cli/tui/reporter.js';

class FakeReporter implements WarmupReporter {
  events: string[] = [];
  start(id: string, _label: string, _opts?: { totalBytes?: number }) { this.events.push(`start:${id}`); }
  update(id: string, text: string) { this.events.push(`update:${id}:${text}`); }
  progress(id: string, fraction: number) { this.events.push(`progress:${id}:${fraction}`); }
  success(id: string, detail?: string) { this.events.push(`success:${id}:${detail ?? ''}`); }
  fail(id: string, error: string) { this.events.push(`fail:${id}:${error}`); }
  note(text: string) { this.events.push(`note:${text}`); }
  finish() { this.events.push('finish'); }
}

const ok = { code: 0, stdout: '', stderr: '', timedOut: false };
const fail = { code: 1, stdout: '', stderr: 'no sudo', timedOut: false };

const argsOf = (call: unknown[]): string[] => (call[1] as string[]) ?? [];
const cmdOf = (call: unknown[]): string => call[0] as string;

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

function setUid(uid: number | undefined): void {
  if (uid === undefined) {
    Object.defineProperty(process, 'getuid', { value: undefined, configurable: true });
  } else {
    Object.defineProperty(process, 'getuid', { value: () => uid, configurable: true });
  }
}

describe('cross-platform browser system deps (GH #116)', () => {
  const realPlatform = process.platform;
  const realGetuid = process.getuid;
  const okLaunch = () => Promise.resolve({ close: () => Promise.resolve() });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(runCommand).mockResolvedValue(ok);
    vi.mocked(chromium.launch).mockImplementation(okLaunch as never);
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
    Object.defineProperty(process, 'getuid', { value: realGetuid, configurable: true });
  });

  it('Linux non-root + no passwordless sudo: skips deps, never invokes sudo, launch-fail surfaces the exact install-deps hint', async () => {
    setPlatform('linux');
    setUid(1000); // non-root
    // sudo -n true fails (no passwordless sudo); binary install succeeds.
    vi.mocked(runCommand).mockImplementation(async (cmd, args) => {
      if (cmd === 'sudo' && args.includes('true')) return fail;
      return ok;
    });
    // Binary on disk but launch throws — classic missing OS libs.
    vi.mocked(chromium.launch).mockRejectedValue(
      new Error('libnss3.so: cannot open shared object file'),
    );

    const reporter = new FakeReporter();
    const result = await runWarmup([], reporter);

    expect(result.playwright).toBe('failed');
    // The result field carries the headline; the exact fix command and the
    // re-run step are emitted as notes so the user sees what to run next.
    expect(result.playwrightError).toBe('system libraries missing — install them with:');
    const notes = reporter.events.filter((e) => e.startsWith('note:'));
    expect(notes.some((n) => n.includes('sudo npx playwright install-deps chromium'))).toBe(true);
    expect(notes.some((n) => n.includes('wigolo warmup'))).toBe(true);
    // Must NEVER have run sudo to actually install (only the -n true probe).
    const installDepsViaSudo = vi.mocked(runCommand).mock.calls.find(
      (c) => cmdOf(c) === 'sudo' && argsOf(c).includes('install-deps'),
    );
    expect(installDepsViaSudo).toBeUndefined();
  });

  it('Linux root: install-deps invoked directly (no sudo)', async () => {
    setPlatform('linux');
    setUid(0); // root

    await runWarmup([]);

    const calls = vi.mocked(runCommand).mock.calls;
    const depsCall = calls.find((c) => argsOf(c).includes('install-deps'));
    expect(depsCall).toBeDefined();
    // Root runs node cli.js install-deps — never via sudo.
    expect(cmdOf(depsCall as unknown[])).toBe(process.execPath);
    expect(argsOf(depsCall as unknown[])).toContain('chromium');
    // No sudo probe at all when root.
    const sudoProbe = calls.find((c) => cmdOf(c) === 'sudo');
    expect(sudoProbe).toBeUndefined();
  });

  it('Linux non-root + passwordless sudo available: install-deps via `sudo -n`', async () => {
    setPlatform('linux');
    setUid(1000);
    // sudo -n true succeeds → passwordless sudo available.
    vi.mocked(runCommand).mockResolvedValue(ok);

    await runWarmup([]);

    const calls = vi.mocked(runCommand).mock.calls;
    const depsCall = calls.find(
      (c) => cmdOf(c) === 'sudo' && argsOf(c).includes('install-deps'),
    );
    expect(depsCall).toBeDefined();
    const args = argsOf(depsCall as unknown[]);
    expect(args[0]).toBe('-n'); // non-interactive, never prompts
    expect(args).toContain('install-deps');
    expect(args).toContain('chromium');
  });

  it('macOS: no deps step attempted at all', async () => {
    setPlatform('darwin');
    setUid(501);

    const result = await runWarmup([]);

    const calls = vi.mocked(runCommand).mock.calls;
    expect(calls.find((c) => argsOf(c).includes('install-deps'))).toBeUndefined();
    expect(calls.find((c) => cmdOf(c) === 'sudo')).toBeUndefined();
    expect(result.playwright).toBe('ok');
  });

  it('launch success ⇒ ok; binary present but launch throws (macOS) ⇒ failed', async () => {
    setPlatform('darwin');
    setUid(501);

    // success path
    let result = await runWarmup([]);
    expect(result.playwright).toBe('ok');

    // launch failure path — not the Linux hint, a generic launch-failed message
    vi.mocked(chromium.launch).mockRejectedValue(new Error('crashed'));
    result = await runWarmup([]);
    expect(result.playwright).toBe('failed');
    expect(result.playwrightError).toContain('failed to launch');
    expect(result.playwrightError).not.toContain('install-deps');
  });
});
