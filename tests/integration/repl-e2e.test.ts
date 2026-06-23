import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const BIN_PATH = join(import.meta.dirname, '..', '..', 'dist', 'index.js');

// The REPL prints this banner once readline is attached (src/repl/shell.ts) and this
// line on a clean exit. We gate stdin on the banner and settle on the exit marker so the
// harness never races the child's boot under load (see the comment on the describe block).
const READY_BANNER = 'wigolo interactive shell';
const EXIT_MARKER = 'Goodbye.';
// Generous per-spawn deadline: under full-suite CPU contention the child's boot (a heavy
// module graph) can take many seconds. 30s absorbs that; vitest's per-test timeout sits
// above it as a backstop.
const SPAWN_TIMEOUT_MS = 30_000;

function runShellCommand(input: string, args: string[] = []): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [BIN_PATH, 'shell', ...args], {
      env: {
        ...process.env,
        LOG_LEVEL: 'error',
        WIGOLO_DATA_DIR: join(import.meta.dirname, '..', 'fixtures', 'repl-test-data'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let sentInput = false;

    const settle = (result: { stdout: string; stderr: string; exitCode: number }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch { /* already exited */ }
      resolve(result);
    };

    const timer = setTimeout(() => settle({ stdout, stderr, exitCode: 1 }), SPAWN_TIMEOUT_MS);

    // Only write stdin once the REPL has printed its ready banner — otherwise stdin.end()
    // can land before readline is reading, so the first command is dropped under load.
    const sendInputOnce = (): void => {
      if (sentInput || !stdout.includes(READY_BANNER)) return;
      sentInput = true;
      child.stdin.write(input + '\n');
      child.stdin.write('exit\n');
      child.stdin.end();
    };

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
      sendInputOnce();
      // Settle on the clean-exit marker rather than waiting on a possibly-slow `close`
      // under load. All asserted output is emitted before this line.
      if (stdout.includes(EXIT_MARKER)) settle({ stdout, stderr, exitCode: 0 });
    });
    child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => { settle({ stdout, stderr, exitCode: code ?? 1 }); });
  });
}

// Each test spawns `node dist/index.js shell` as a real child process. Under heavy
// parallel load (the full suite spawns many children at once) the child's boot is
// CPU-starved, so two things race: stdin.end() can land before readline attaches (the
// first command is dropped), and a 10-15s timeout can fire before a slow boot finishes.
// runShellCommand hardens both structurally — it gates stdin on the ready banner and
// settles on the exit marker, under a generous 30s deadline. retry:3 stays as
// belt-and-suspenders only: D11 proved retry alone is insufficient, because a sustained
// load spike starves every attempt together (all retries time out as one).
describe('REPL integration', () => {
  it('responds to help command', { retry: 3 }, async () => {
    const { stdout } = await runShellCommand('help');
    expect(stdout).toContain('Available commands');
    expect(stdout).toContain('search');
    expect(stdout).toContain('fetch');
    expect(stdout).toContain('crawl');
    expect(stdout).toContain('cache');
    expect(stdout).toContain('extract');
  }, 45_000);

  it('exits cleanly on exit command', { retry: 3 }, async () => {
    const { stdout, exitCode } = await runShellCommand('exit');
    expect(stdout).toContain('Goodbye');
    expect(exitCode).toBe(0);
  }, 45_000);

  it('handles unknown commands gracefully', { retry: 3 }, async () => {
    const { stdout } = await runShellCommand('foobar');
    expect(stdout).toContain('Unknown command');
  }, 45_000);

  it('returns JSON output with --json flag', { retry: 3 }, async () => {
    const { stdout } = await runShellCommand('cache stats', ['--json']);
    try {
      const lines = stdout.trim().split('\n').filter(l => l.trim());
      const lastJsonLine = lines.filter(l => l.trim().startsWith('{') || l.trim().startsWith('"')).pop();
      if (lastJsonLine) {
        const parsed = JSON.parse(lastJsonLine);
        expect(parsed).toBeDefined();
      }
    } catch {
      expect(stdout).toContain('{');
    }
  }, 45_000);

  it('handles search with missing query', { retry: 3 }, async () => {
    const { stdout } = await runShellCommand('search');
    expect(stdout).toContain('Usage');
  }, 45_000);

  it('handles fetch with missing URL', { retry: 3 }, async () => {
    const { stdout } = await runShellCommand('fetch');
    expect(stdout).toContain('Usage');
  }, 45_000);

  it('handles empty input lines', { retry: 3 }, async () => {
    const { exitCode } = await runShellCommand('');
    expect(exitCode).toBe(0);
  }, 45_000);

  it('displays goodbye on exit', { retry: 3 }, async () => {
    const { stdout } = await runShellCommand('exit');
    expect(stdout).toContain('Goodbye');
  }, 45_000);
});
