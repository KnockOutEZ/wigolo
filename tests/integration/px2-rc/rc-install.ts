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
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
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
  /**
   * A data dir of its own — this is what makes the install FRESH.
   *
   * `tests/setup.ts` seeds a real signed entitlement token carrying a perpetual
   * `core` grant into ONE shared `WIGOLO_DATA_DIR` and pins its own keypair, so
   * every suite starts activated. Inheriting that would destroy this whole file:
   * the refusal arms could not refuse, and — because the seeded token is signed
   * by the suite's key rather than the local service's — the gate answered
   * "update wigolo" instead, which is how the first run of this suite failed.
   * That setup file names this exact remedy: an un-activated install is one whose
   * data dir is empty.
   */
  dataDir: string;
  /** Absolute path into the installed package, for importing its own modules. */
  packageDir: string;
  /** Where the egress fence appends every non-loopback destination it blocked. */
  egressRecord: string;
  omitOptional: boolean;
}

/** The child-process egress fence — see `egress-fence.cjs` for why it is required. */
const EGRESS_FENCE = join(import.meta.dirname, 'egress-fence.cjs');

/** Every non-loopback destination the install attempted, as `kind\thost` lines. */
export async function blockedEgress(install: FreshInstall): Promise<string[]> {
  try {
    const raw = await readFile(install.egressRecord, 'utf8');
    return raw.split('\n').filter((line) => line.trim().length > 0);
  } catch {
    return [];
  }
}

/**
 * The environment every arm hands the installed binary.
 *
 * Merged over the caller's env so an arm cannot forget the isolation, and set
 * explicitly rather than inherited so the arm does not depend on what the
 * ambient test bootstrap happens to export.
 */
export function installEnv(install: FreshInstall): Record<string, string> {
  return {
    HOME: install.home,
    USERPROFILE: install.home,
    WIGOLO_DATA_DIR: install.dataDir,
    // Keep the cross-encoder off: it would be a model download on first use,
    // which is neither local nor deterministic.
    WIGOLO_RERANKER: 'none',
    // The fixture site, the stub engine and the accounts service all bind
    // 127.0.0.1, and the SSRF guard refuses loopback by default — measured: the
    // `watch` tool answered "url resolves to a loopback / private IPv4" and did
    // no work at all. This is the product's own opt-in for exactly this case.
    WIGOLO_FETCH_ALLOW_PRIVATE: '1',
    RC_EGRESS_RECORD: install.egressRecord,
    // Preloaded into every spawn: the suite's own fence cannot see a child.
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require ${EGRESS_FENCE}`.trim(),
  };
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
  const dataDir = await mkdtemp(join(tmpdir(), 'wigolo-rc-data-'));

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
    dataDir,
    bin: join(root, 'node_modules', '.bin', 'wigolo'),
    packageDir: join(root, 'node_modules', 'wigolo'),
    egressRecord: join(root, 'rc-egress.log'),
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
      // A one-shot must not inherit a developer's — or the test bootstrap's —
      // account wiring. Both are cleared before the arm's own values land.
      WIGOLO_ACCOUNTS_URL: undefined,
      WIGOLO_ACCOUNTS_PUBKEY: undefined,
      ...installEnv(install),
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
