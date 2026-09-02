/**
 * PX2 RC exit gate — the fresh install, and the two surfaces it is driven from.
 *
 * WHY A PACKED TARBALL AND NOT THE WORKING TREE. The gate's first clause is
 * about what a person who has never run wigolo meets, and the working tree is
 * not that: it has a built `dist/`, a populated `node_modules`, and whatever
 * state previous runs left in it. `npm pack` + install into `$TMPDIR` is the
 * closest honest approximation of `npm i -g wigolo` that does not publish
 * anything (the publish itself is the Q-lane stub's, not this issue's).
 *
 * WHY BOTH INSTALL ARMS EXIST. Optional-dependency prebuilds fail silently, so
 * an install that happened to lose one would still be green while quietly
 * exercising a different credential-custody tier than the one someone believed
 * was covered. The full arm asserts and RECORDS which tier actually ran; the
 * `--omit=optional` arm forces the other one deterministically (A-212-11).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { stopChild } from './rc-accounts-service.js';
import { CORE_REPO_ROOT } from './rc-gate-env.js';

export interface PackedTarball {
  /** Absolute path to the `.tgz` `npm pack` produced. */
  path: string;
  directory: string;
}

/**
 * Pack the tree under test.
 *
 * `npm pack` runs the `prepare` hook, so the tarball carries a build made from
 * this branch rather than whatever was last left in `dist/` — which is the
 * property that makes the arm a test of the branch and not of the machine.
 */
export async function packWigolo(): Promise<PackedTarball> {
  const directory = await mkdtemp(join(tmpdir(), 'wigolo-rc-pack-'));
  await run('npm', ['pack', CORE_REPO_ROOT, '--pack-destination', directory], {
    cwd: directory,
    timeoutMs: 600_000,
  });

  const packed = (await readdir(directory)).filter((name) => name.endsWith('.tgz'));
  if (packed.length !== 1) {
    throw new Error(`expected exactly one tarball in ${directory}, found ${packed.length}`);
  }
  return { path: join(directory, packed[0]), directory };
}

export interface FreshInstall {
  /** The sandbox the tarball was installed into. */
  root: string;
  /** The installed `wigolo` executable. */
  bin: string;
  /** A HOME of its own, so the install starts with no account and no cache. */
  home: string;
  /** Absolute path into the installed package, for importing its own modules. */
  packageDir: string;
  omitOptional: boolean;
}

/**
 * Install the tarball into a throwaway prefix with a throwaway HOME.
 *
 * The HOME matters as much as the prefix: the activation state, the cache and
 * the credential file all hang off it, so sharing one with the developer's
 * machine would let a previously-registered install make the refusal arm pass
 * for the wrong reason.
 */
export async function installTarball(
  tarball: string,
  options: { omitOptional?: boolean } = {},
): Promise<FreshInstall> {
  const omitOptional = options.omitOptional ?? false;
  const root = await mkdtemp(join(tmpdir(), omitOptional ? 'wigolo-rc-omit-' : 'wigolo-rc-full-'));
  const home = await mkdtemp(join(tmpdir(), 'wigolo-rc-home-'));

  await writeFile(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'wigolo-rc-sandbox', private: true, version: '1.0.0' }, null, 2)}\n`,
    'utf8',
  );

  const args = [
    'install',
    tarball,
    '--no-audit',
    '--no-fund',
    ...(omitOptional ? ['--omit=optional'] : []),
  ];
  await run('npm', args, { cwd: root, timeoutMs: 900_000 });

  return {
    root,
    home,
    bin: join(root, 'node_modules', '.bin', 'wigolo'),
    packageDir: join(root, 'node_modules', 'wigolo'),
    omitOptional,
  };
}

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** stdout and stderr interleaved in arrival order — what a person would see. */
  combined: string;
}

export interface RunCliOptions {
  env?: Record<string, string>;
  /** Lines fed to the process's stdin, in order, as prompts consume them. */
  stdin?: readonly string[];
  timeoutMs?: number;
  /** Called once the process is live — how the registration arm reads the outbox. */
  onStarted?: (child: ChildProcess, write: (line: string) => void) => Promise<void> | void;
}

/**
 * Run the installed binary.
 *
 * The environment is REPLACED rather than extended for the account-shaped
 * variables: an inherited `WIGOLO_ACCOUNTS_URL` from the developer's shell would
 * silently redirect an arm, and the acceptance criteria require every arm to set
 * both accounts variables explicitly.
 */
export async function runCli(
  install: FreshInstall,
  args: readonly string[],
  options: RunCliOptions = {},
): Promise<CommandResult> {
  const child = spawn(install.bin, [...args], {
    cwd: install.root,
    env: {
      ...process.env,
      HOME: install.home,
      // A one-shot must not inherit a developer's backend choice.
      WIGOLO_ACCOUNTS_URL: undefined,
      WIGOLO_ACCOUNTS_PUBKEY: undefined,
      ...options.env,
    } as NodeJS.ProcessEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  let combined = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); combined += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); combined += chunk.toString(); });

  const write = (line: string): void => { child.stdin.write(`${line}\n`); };

  if (options.onStarted !== undefined) {
    await options.onStarted(child, write);
  }
  for (const line of options.stdin ?? []) write(line);
  child.stdin.end();

  const timeoutMs = options.timeoutMs ?? 180_000;
  const code = await waitForExit(child, timeoutMs, () => combined);

  return { code, stdout, stderr, combined };
}

async function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
  transcript: () => string,
): Promise<number | null> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void stopChild(child);
      reject(new Error(`command exceeded ${timeoutMs}ms:\n${transcript()}`));
    }, timeoutMs);
  });
  const exited = new Promise<number | null>((resolveExit) => {
    child.once('close', (code) => resolveExit(code));
  });
  try {
    return await Promise.race([exited, timedOut]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Spawn a command and fail loudly on a non-zero exit. */
export async function run(
  command: string,
  args: readonly string[],
  options: { cwd: string; timeoutMs?: number; env?: Record<string, string> },
): Promise<CommandResult> {
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  let combined = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); combined += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); combined += chunk.toString(); });

  const code = await waitForExit(child, options.timeoutMs ?? 300_000, () => combined);
  if (code !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${code}:\n${combined}`);
  }
  return { code, stdout, stderr, combined };
}
