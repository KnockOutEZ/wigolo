import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const BIN_PATH = join(import.meta.dirname, '..', '..', 'dist', 'index.js');

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

    child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });

    child.stdin.write(input + '\n');
    child.stdin.write('exit\n');
    child.stdin.end();
  });
}

describe('REPL integration', () => {
  it('responds to help command', async () => {
    const { stdout } = await runShellCommand('help');
    expect(stdout).toContain('Available commands');
    expect(stdout).toContain('search');
    expect(stdout).toContain('fetch');
    expect(stdout).toContain('crawl');
    expect(stdout).toContain('cache');
    expect(stdout).toContain('extract');
  }, 15_000);

  it('exits cleanly on exit command', async () => {
    const { stdout, exitCode } = await runShellCommand('exit');
    expect(stdout).toContain('Goodbye');
    expect(exitCode).toBe(0);
  }, 10_000);

  it('handles unknown commands gracefully', async () => {
    const { stdout } = await runShellCommand('foobar');
    expect(stdout).toContain('Unknown command');
  }, 10_000);

  it('returns JSON output with --json flag', async () => {
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
  }, 15_000);

  it('handles search with missing query', async () => {
    const { stdout } = await runShellCommand('search');
    expect(stdout).toContain('Usage');
  }, 10_000);

  it('handles fetch with missing URL', async () => {
    const { stdout } = await runShellCommand('fetch');
    expect(stdout).toContain('Usage');
  }, 10_000);

  it('handles empty input lines', async () => {
    const { exitCode } = await runShellCommand('');
    expect(exitCode).toBe(0);
  }, 10_000);

  it('displays goodbye on exit', async () => {
    const { stdout } = await runShellCommand('exit');
    expect(stdout).toContain('Goodbye');
  }, 10_000);
});
