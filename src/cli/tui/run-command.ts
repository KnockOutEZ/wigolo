import { spawn, type SpawnOptions } from 'node:child_process';

export interface RunCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
}

export interface RunCommandResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export async function runCommand(
  cmd: string,
  args: string[],
  opts: RunCommandOptions = {},
): Promise<RunCommandResult> {
  return new Promise((resolve, reject) => {
    const spawnOpts: SpawnOptions = {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    };

    let child;
    try {
      child = spawn(cmd, args, spawnOpts);
    } catch (err) {
      reject(err);
      return;
    }

    let stdout = '';
    let stderr = '';
    let stdoutBuf = '';
    let stderrBuf = '';
    let timedOut = false;

    const flushLines = (buf: string, stream: 'stdout' | 'stderr'): string => {
      const parts = buf.split('\n');
      const tail = parts.pop() ?? '';
      for (const line of parts) {
        if (opts.onLine) opts.onLine(line, stream);
      }
      return tail;
    };

    child.stdout?.setEncoding('utf-8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
      stdoutBuf = flushLines(stdoutBuf + chunk, 'stdout');
    });
    child.stderr?.setEncoding('utf-8');
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
      stderrBuf = flushLines(stderrBuf + chunk, 'stderr');
    });

    let timer: NodeJS.Timeout | null = null;
    if (opts.timeout && opts.timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2000).unref();
      }, opts.timeout);
    }

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (stdoutBuf && opts.onLine) opts.onLine(stdoutBuf, 'stdout');
      if (stderrBuf && opts.onLine) opts.onLine(stderrBuf, 'stderr');
      resolve({
        code: code ?? (timedOut ? -1 : 1),
        stdout,
        stderr,
        timedOut,
      });
    });
  });
}
