/**
 * PX2 RC exit gate — a real accounts service, on a real database, on this machine.
 *
 * WHY EMBEDDED POSTGRES AND NOT DOCKER. The gate has to be runnable unattended
 * on a developer machine and in CI without anyone starting a daemon first, and
 * the accounts repo already solved this for its own suite: it boots one real
 * cluster into `$TMPDIR`. Reusing that library through the accounts checkout
 * keeps "verified against real Postgres" true while adding no service
 * container, and the binaries are already on disk next to the checkout, so the
 * arms stay offline (A-212-11).
 *
 * WHY THE CLOCK IS INJECTED THROUGH OUR OWN BOOTSTRAP FOR ONE ARM. The service's
 * `src/index.ts` hardcodes `systemClock`, and `valid_until` is `issued_at +
 * ENTITLEMENT_TOKEN_TTL_MS` — seven days, NOT capped by the grant's own expiry.
 * So revoking the perpetual grant and ageing the client's `last_refresh_at` is
 * not sufficient to reach the gate's expired arm: the freshly refreshed token is
 * still inside its own validity window, and step 4 passes before grace is ever
 * consulted. The service's clock seam exists precisely for this — its docstring
 * names the exit-gate suite as the caller — so the grace arm boots the SAME
 * service modules with that seam moved instead of softening the assertion.
 * `startAccountsService` with no offset runs the shipped `src/index.ts`, so the
 * ordinary arms still exercise the real boot path.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createPublicKey } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { accountsRepoPath } from './rc-gate-env.js';

/**
 * Import a module by absolute filesystem path.
 *
 * The URL is built by `pathToFileURL` and held in a variable before `import`
 * sees it. An inline `import(\`file://${path}\`)` is rewritten by the test
 * bundler's resolver, which reads the `${` as a hostname and warns
 * "Invalid file URL: must not contain hostname" — measured on the first run of
 * this suite. Keeping the specifier opaque leaves the resolution to Node at
 * runtime, which is the only thing that can know where the accounts checkout is.
 */
async function importFromPath(absolutePath: string): Promise<Record<string, unknown>> {
  const specifier = pathToFileURL(absolutePath).href;
  return (await import(/* @vite-ignore */ specifier)) as Record<string, unknown>;
}

/** Bind port 0, read what the OS handed out, release it. */
export function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('could not determine a free port'));
        return;
      }
      const { port } = address;
      server.close(() => resolvePort(port));
    });
  });
}

export interface PostgresCluster {
  /** Admin connection string for the cluster's default database. */
  adminUrl: string;
  /** Connection string for a database created on this cluster. */
  databaseUrl(name: string): string;
  createDatabase(name: string): Promise<void>;
  stop(): Promise<void>;
}

/**
 * One real cluster in `$TMPDIR`, torn down with its data directory.
 *
 * THE TRAP THIS FUNCTION EXISTS TO DISARM. Loading the cluster library installs
 * a `beforeExit` listener that force-exits the process with code 0 once the loop
 * drains, and an `exit` listener that calls an async-style callback
 * synchronously. In a runner that reports failure by setting `process.exitCode`,
 * the first one turns every red run green — the suite would pass no matter what
 * broke, which in an exit gate is the worst possible failure mode. The accounts
 * repo's own global setup documents and removes them; this does the same, by
 * diffing the listener sets around a deferred import.
 */
export async function startPostgresCluster(): Promise<PostgresCluster> {
  const accountsRepo = accountsRepoPath();
  const port = await freePort();
  const databaseDir = await mkdtemp(join(tmpdir(), 'wigolo-rc-pg-'));

  const beforeExitWas = new Set(process.listeners('beforeExit'));
  const exitWas = new Set(process.listeners('exit'));

  // Resolved through the accounts checkout: the library and its platform binary
  // are that repo's dependency, not core's.
  const requireFromAccounts = createRequire(join(accountsRepo, 'package.json'));
  const loaded = await importFromPath(requireFromAccounts.resolve('embedded-postgres'));
  const EmbeddedPostgres = resolveClusterConstructor(loaded);

  const installedBeforeExit = process
    .listeners('beforeExit')
    .filter((listener) => !beforeExitWas.has(listener));
  const installedExit = process.listeners('exit').filter((listener) => !exitWas.has(listener));
  for (const listener of installedBeforeExit) process.removeListener('beforeExit', listener);
  for (const listener of installedExit) process.removeListener('exit', listener);

  const user = 'postgres';
  const password = 'postgres';
  const cluster = new EmbeddedPostgres({
    databaseDir,
    user,
    password,
    port,
    // stop() removes the data directory, so a run leaves nothing in $TMPDIR.
    persistent: false,
    onLog: () => undefined,
    onError: () => undefined,
  });

  await cluster.initialise();
  await cluster.start();

  const base = `postgres://${user}:${password}@127.0.0.1:${port}`;

  return {
    adminUrl: `${base}/postgres`,
    databaseUrl: (name: string) => `${base}/${name}`,
    createDatabase: async (name: string) => {
      await cluster.createDatabase(name);
    },
    stop: async () => {
      await cluster.stop();
      await rm(databaseDir, { recursive: true, force: true });
    },
  };
}

interface ClusterInstance {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  createDatabase(name: string): Promise<void>;
}

interface ClusterConstructor {
  new (options: {
    databaseDir: string;
    user: string;
    password: string;
    port: number;
    persistent: boolean;
    onLog: () => void;
    onError: () => void;
  }): ClusterInstance;
}

/**
 * The library ships as CJS with an interop default, so the constructor can sit
 * at `default`, at `default.default`, or at the namespace itself depending on how
 * the loader wrapped it. Probing all three is cheaper than pinning a shape that
 * changes with the bundler.
 */
function resolveClusterConstructor(loaded: { default?: unknown }): ClusterConstructor {
  const candidates = [
    (loaded.default as { default?: unknown } | undefined)?.default,
    loaded.default,
    loaded,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'function') return candidate as ClusterConstructor;
  }
  throw new Error('embedded-postgres did not export a constructor');
}

export interface AccountsService {
  /** `http://127.0.0.1:<port>` — what `WIGOLO_ACCOUNTS_URL` is set to. */
  url: string;
  /** The service's own key id, read from `/health`. */
  kid: string;
  /** Raw Ed25519 public key, base64url — what `WIGOLO_ACCOUNTS_PUBKEY` is set to. */
  publicKeyB64Url: string;
  /** Absolute path to the service's data dir (holds the dev outbox and the key). */
  dataDir: string;
  databaseUrl: string;
  stop(): Promise<void>;
}

export interface StartAccountsServiceOptions {
  databaseUrl: string;
  /** Reuse an existing data dir — the grace arm restarts onto the same keys. */
  dataDir?: string;
  /**
   * Shift the service's clock seam by this many milliseconds. Zero (the default)
   * boots the shipped `src/index.ts`; anything else boots the same modules
   * through {@link CLOCK_BOOTSTRAP} with the seam moved.
   */
  clockOffsetMs?: number;
}

/**
 * Our own boot, mirroring `src/index.ts` but taking the clock from the
 * environment.
 *
 * It lives in `$TMPDIR` and imports the service by absolute `file://` URL: the
 * accounts checkout is not ours to write into, and a file placed there would be
 * scratch inside a repo. Everything it constructs is the service's own —
 * config, pool, migrations, keys, mailer, app — so the only difference from the
 * shipped boot is which function answers "what time is it".
 */
const CLOCK_BOOTSTRAP = `
const repo = process.env.RC_ACCOUNTS_REPO;
const { buildApp } = await import(\`file://\${repo}/src/app.ts\`);
const { loadConfig } = await import(\`file://\${repo}/src/config.ts\`);
const { runMigrations } = await import(\`file://\${repo}/src/db/migrate.ts\`);
const { createPool } = await import(\`file://\${repo}/src/db/pool.ts\`);
const { loadKeyService } = await import(\`file://\${repo}/src/entitlements/keys.ts\`);
const { createLogger } = await import(\`file://\${repo}/src/logger.ts\`);
const { createMailer } = await import(\`file://\${repo}/src/mail/mailer.ts\`);

const offsetMs = Number(process.env.RC_CLOCK_OFFSET_MS ?? '0');
const now = () => new Date(Date.now() + offsetMs);

const config = loadConfig();
const logger = createLogger({ level: config.logLevel });
const db = createPool(config, { logger });
await runMigrations(db, { now, logger });
const keys = await loadKeyService(config, { logger });
const mail = createMailer(config, logger);
const app = await buildApp({ config, db, now, keys, mail, logger });
await app.listen({ host: config.host, port: config.port });
`;

/**
 * Spawn the service and wait until `/health` answers.
 *
 * Run through the checkout's own `tsx` rather than its `dist/`: a stale build
 * would have the gate assert against code that is not the branch's, and the
 * whole point of the arm is that the client meets the service as it is now.
 */
export async function startAccountsService(
  options: StartAccountsServiceOptions,
): Promise<AccountsService> {
  const accountsRepo = accountsRepoPath();
  const port = await freePort();
  const dataDir = options.dataDir ?? (await mkdtemp(join(tmpdir(), 'wigolo-rc-accounts-')));
  const clockOffsetMs = options.clockOffsetMs ?? 0;

  let entry: string;
  let cwd: string;
  if (clockOffsetMs === 0) {
    entry = 'src/index.ts';
    cwd = accountsRepo;
  } else {
    const bootstrap = join(await mkdtemp(join(tmpdir(), 'wigolo-rc-boot-')), 'boot.mts');
    await writeFile(bootstrap, CLOCK_BOOTSTRAP, 'utf8');
    entry = bootstrap;
    cwd = accountsRepo;
  }

  const child = spawn(join(accountsRepo, 'node_modules/.bin/tsx'), [entry], {
    cwd,
    env: {
      ...process.env,
      ACCOUNTS_DATABASE_URL: options.databaseUrl,
      ACCOUNTS_HOST: '127.0.0.1',
      ACCOUNTS_PORT: String(port),
      ACCOUNTS_DATA_DIR: dataDir,
      NODE_ENV: 'development',
      ACCOUNTS_LOG_LEVEL: 'warn',
      RC_ACCOUNTS_REPO: accountsRepo,
      RC_CLOCK_OFFSET_MS: String(clockOffsetMs),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let transcript = '';
  child.stdout.on('data', (chunk: Buffer) => { transcript += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { transcript += chunk.toString(); });

  const url = `http://127.0.0.1:${port}`;
  const health = await waitForHealth(url, child, () => transcript);

  const publicKeyB64Url = await readServicePublicKey(dataDir);

  return {
    url,
    kid: health.kid,
    publicKeyB64Url,
    dataDir,
    databaseUrl: options.databaseUrl,
    stop: () => stopChild(child),
  };
}

interface HealthBody {
  status: string;
  kid: string;
}

async function waitForHealth(
  url: string,
  child: ChildProcess,
  transcript: () => string,
): Promise<HealthBody> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `the accounts service exited with ${child.exitCode} before answering /health:\n${transcript()}`,
      );
    }
    try {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) {
        const body = (await response.json()) as HealthBody;
        if (body.status === 'ok') return body;
      }
    } catch {
      // Not up yet. The deadline is the only thing that decides we are wrong.
    }
    await delay(250);
  }
  throw new Error(`the accounts service never became healthy:\n${transcript()}`);
}

/**
 * The verification key the client must trust, derived from the service's own
 * signing key rather than from anything the service serves.
 *
 * `GET /entitlements/keys` exists and is deliberately not used: a key list from
 * the host that mints the tokens proves nothing (`src/account/pinned-keys.ts`
 * says so at length), and the gate is exactly the property that would be
 * hollowed out by trusting it. The JWK `x` of the public half of the PKCS8
 * private key IS the raw 32-byte key, base64url — the encoding
 * `WIGOLO_ACCOUNTS_PUBKEY` takes.
 */
async function readServicePublicKey(dataDir: string): Promise<string> {
  const pem = await readFile(join(dataDir, 'entitlement-signing.pem'), 'utf8');
  const jwk = createPublicKey(pem).export({ format: 'jwk' }) as { x?: string };
  if (typeof jwk.x !== 'string' || jwk.x.length === 0) {
    throw new Error('the service signing key did not yield a raw public key');
  }
  return jwk.x;
}

/** The sign-in code a person would have read, from the dev outbox on disk. */
export async function readOutboxCode(dataDir: string, email: string): Promise<string> {
  const outbox = join(dataDir, 'outbox');
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    let names: string[] = [];
    try {
      names = await readdir(outbox);
    } catch {
      names = [];
    }
    // The name leads with a sortable timestamp, so the last match is the newest.
    const mine = names
      .filter((name) => name.includes('auth_code') && name.includes(sanitizeAddress(email)))
      .sort();
    const newest = mine.at(-1);
    if (newest !== undefined) {
      const body = await readFile(join(outbox, newest), 'utf8');
      const code = body.match(/^\s*(\d{6})\s*$/m)?.[1];
      if (code !== undefined) return code;
    }
    await delay(200);
  }
  throw new Error(`no sign-in code appeared in the dev outbox for ${email}`);
}

/** The dev transport's filename reduction: anything outside its alphabet becomes `_`. */
function sanitizeAddress(address: string): string {
  return address.replace(/[^A-Za-z0-9._@+-]+/g, '_');
}

/** The whole outbox file, for the demo transcript. */
export async function readOutboxMail(dataDir: string, email: string): Promise<string> {
  const outbox = join(dataDir, 'outbox');
  const names = (await readdir(outbox))
    .filter((name) => name.includes('auth_code') && name.includes(sanitizeAddress(email)))
    .sort();
  const newest = names.at(-1);
  if (newest === undefined) throw new Error(`no outbox mail for ${email}`);
  return readFile(join(outbox, newest), 'utf8');
}

/**
 * Run SQL against the service's database with the accounts checkout's own
 * driver.
 *
 * Raw SQL rather than an API call is the point of the grace arm (PX1-G
 * precedent): PX1 exposes no endpoint that revokes a grant, so an arm written
 * against the API could only have tested a state the service will not enter, and
 * the honest way to reach "this account's perpetual grant is gone" is to put the
 * database in that state.
 */
export async function withServiceDatabase<T>(
  databaseUrl: string,
  run: (query: (sql: string, params?: readonly unknown[]) => Promise<{ rows: Record<string, unknown>[] }>) => Promise<T>,
): Promise<T> {
  const accountsRepo = accountsRepoPath();
  const requireFromAccounts = createRequire(join(accountsRepo, 'package.json'));
  const loaded = (await importFromPath(requireFromAccounts.resolve('pg'))) as {
    default?: { Client?: unknown };
    Client?: unknown;
  };
  const ClientCtor = (loaded.default?.Client ?? loaded.Client) as
    | (new (config: { connectionString: string }) => {
        connect(): Promise<void>;
        query(sql: string, params?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
        end(): Promise<void>;
      })
    | undefined;
  if (ClientCtor === undefined) throw new Error('the accounts checkout did not export a pg Client');

  const client = new ClientCtor({ connectionString: databaseUrl });
  await client.connect();
  try {
    return await run((sql, params) => client.query(sql, params));
  } finally {
    await client.end();
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

/** SIGTERM, then SIGKILL if it does not go. */
export async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolveExit) => child.once('close', () => resolveExit()));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}
