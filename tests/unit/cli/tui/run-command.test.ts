import { describe, it, expect } from 'vitest';
import { runCommand } from '../../../../src/cli/tui/run-command.js';

describe('runCommand', () => {
  it('resolves with code=0 and captured stdout on success', async () => {
    const r = await runCommand('node', ['-e', 'process.stdout.write("hello")']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('hello');
    expect(r.stderr).toBe('');
  });

  it('resolves with non-zero code when the process exits non-zero', async () => {
    const r = await runCommand('node', ['-e', 'process.exit(2)']);
    expect(r.code).toBe(2);
  });

  it('captures stderr separately', async () => {
    const r = await runCommand('node', ['-e', 'process.stderr.write("oops")']);
    expect(r.stderr).toBe('oops');
    expect(r.stdout).toBe('');
  });

  it('invokes onLine callback per stdout line', async () => {
    const lines: string[] = [];
    await runCommand(
      'node',
      ['-e', 'console.log("one"); console.log("two"); console.log("three");'],
      { onLine: (line) => lines.push(line) },
    );
    expect(lines).toEqual(['one', 'two', 'three']);
  });

  it('respects timeout and kills the child', async () => {
    const start = Date.now();
    const r = await runCommand('node', ['-e', 'setTimeout(() => {}, 10000)'], { timeout: 300 });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(3000);
    expect(r.code).not.toBe(0);
    expect(r.timedOut).toBe(true);
  });

  it('rejects with an Error when spawn itself fails (ENOENT)', async () => {
    await expect(runCommand('/no/such/binary/xyz', [])).rejects.toThrow();
  });

  it('passes through env', async () => {
    const r = await runCommand('node', ['-e', 'process.stdout.write(process.env.WIGOLO_X || "")'], {
      env: { ...process.env, WIGOLO_X: 'yes' },
    });
    expect(r.stdout).toBe('yes');
  });
});
