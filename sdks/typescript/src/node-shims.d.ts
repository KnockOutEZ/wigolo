/**
 * Minimal ambient declarations for the handful of Node built-ins the node-only
 * `local.ts` uses. Declared inline so the SDK's devDependencies stay limited to
 * the type-checker and the test runner — it pulls in no `@types/node`. These
 * cover ONLY the surface this SDK touches, not the full Node type set.
 */

declare namespace NodeJS {
  type Signals = 'SIGTERM' | 'SIGKILL' | 'SIGINT' | string;
  interface ProcessEnv {
    [key: string]: string | undefined;
  }
  interface Process {
    platform: string;
    env: ProcessEnv;
    pid: number;
    on(event: 'exit', listener: () => void): void;
    removeListener(event: 'exit', listener: () => void): void;
  }
}

declare const process: NodeJS.Process;

interface Buffer {
  toString(encoding?: string): string;
}

declare function setTimeout(handler: () => void, ms: number): unknown;
declare function clearTimeout(handle: unknown): void;

declare module 'node:child_process' {
  interface ChildProcessStream {
    on(event: 'data', listener: (chunk: Buffer) => void): void;
  }
  export interface ChildProcess {
    pid?: number;
    killed: boolean;
    stderr: ChildProcessStream | null;
    kill(signal?: NodeJS.Signals): boolean;
    on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
    on(event: 'error', listener: (err: Error) => void): void;
  }
  export interface SpawnOptions {
    env?: NodeJS.ProcessEnv;
    stdio?: Array<'ignore' | 'pipe' | 'inherit'>;
    windowsHide?: boolean;
  }
  export function spawn(command: string, args: string[], options?: SpawnOptions): ChildProcess;
}

declare module 'node:fs' {
  export function existsSync(path: string): boolean;
}

declare module 'node:path' {
  export const delimiter: string;
  export function join(...parts: string[]): string;
}
