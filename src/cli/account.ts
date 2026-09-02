/**
 * The five account verbs (PX2 mini-spec §6): `register`, `login`, `logout`,
 * `whoami`, `account`.
 *
 * ALL FIVE ARE GATE-EXEMPT BY CONSTRUCTION. They are the only way an install
 * becomes activated, so a gate in front of them would be a deadlock rather than
 * a policy. Nothing here reaches a tool handler.
 *
 * WHY THE PROMPTS DO NOT ASK WHETHER STDIN IS A TTY (A-212-9). Every prompt
 * reads the next line off one long-lived reader with `terminal: false`, so a
 * piped stdin and a human at a keyboard walk the SAME code path. A TTY still
 * echoes what is typed (the terminal does that, not readline), and a pipe
 * delivers its buffered lines in order — which is what lets the RC gate drive
 * registration end to end without a pseudo-terminal. The alternative in the
 * tree (`plugin.ts`, `terminal: true` plus an `isTTY` bail-out) is the shape
 * this deliberately does not copy: it makes the scripted path a second,
 * untested path.
 *
 * WHY ONE READER FOR A WHOLE VERB. A fresh `createInterface` per question
 * swallows whatever the previous one had already buffered, so a piped
 * `email\ncode\ny` would lose the code. One reader per invocation, consumed as
 * an async iterator, is the only shape that reads a pipe correctly.
 *
 * HUMAN TEXT GOES TO STDERR, `--json` GOES TO STDOUT — the house contract
 * (`tests/unit/cli/json-contracts.test.ts`): exactly one JSON document on
 * stdout and nothing else, so the output pipes through `jq` while the prompts
 * still reach the person answering them.
 */

import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
import { getConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { isTelemetryEnabled } from './telemetry.js';
import { AccountsClient } from '../account/client.js';
import { AccountStateStore, type AccountState } from '../account/state.js';
import {
  clearAccessToken,
  deleteRefreshToken,
  getAccessToken,
  setAccessToken,
  storeRefreshToken,
} from '../account/token-store.js';
import { refreshEntitlementsNow } from '../account/refresh.js';
import { evaluateActivation, ACTIVATION_GRACE_MS, type ActivationDecision } from '../account/gate.js';
import { verifyEntitlementToken, type EntitlementGrant } from '../account/entitlements.js';
import { resolvePinnedKeys, type PinnedKeySet } from '../account/pinned-keys.js';
import { accountsUrlOverride, type AccountsUrlOverride } from './accounts-url-notice.js';

const log = createLogger('cli');

/** The verbs this module owns. Mirrors the `Command` union members added for PX2. */
export type AccountVerb = 'register' | 'login' | 'logout' | 'whoami' | 'account';

export interface AccountCliDeps {
  /** Defaults to `getConfig().dataDir`. */
  dataDir?: string;
  /** Effective account service address. Defaults to `getConfig().accountsUrl`. */
  accountsUrl?: string;
  /** Injected in tests so no verb needs a live socket. */
  client?: AccountsClient;
  input?: NodeJS.ReadableStream;
  /** Human text and prompts. Defaults to stderr. */
  stderr?: NodeJS.WritableStream;
  /** `--json` documents. Defaults to stdout. */
  stdout?: NodeJS.WritableStream;
  env?: NodeJS.ProcessEnv;
  nowMs?: () => number;
}

// ---------------------------------------------------------------------------
// Prompting
// ---------------------------------------------------------------------------

export interface LinePrompter {
  /** Write `question`, then resolve the next input line. `null` at end of input. */
  ask(question: string): Promise<string | null>;
  close(): void;
}

export function createLinePrompter(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): LinePrompter {
  const rl = createInterface({ input, terminal: false });
  const lines = rl[Symbol.asyncIterator]();
  return {
    async ask(question: string): Promise<string | null> {
      output.write(question);
      const next = await lines.next();
      if (next.done === true) return null;
      return String(next.value);
    },
    close(): void {
      rl.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

function flagValue(args: readonly string[], name: string): string | null {
  const inline = args.find((a) => a.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const idx = args.indexOf(name);
  if (idx >= 0 && idx + 1 < args.length && !args[idx + 1].startsWith('-')) return args[idx + 1];
  return null;
}

/** Deliberately permissive: the accounts service is the authority on an address,
 *  and a client-side pattern that rejects a deliverable address is a worse bug
 *  than one that forwards an undeliverable one. This only catches "empty" and
 *  "obviously not an address" before spending a round trip. */
function looksLikeEmail(value: string): boolean {
  const v = value.trim();
  return v.length >= 3 && v.includes('@') && !v.startsWith('@') && !v.endsWith('@') && !/\s/.test(v);
}

/** `v1.<kid>.<payload>.<sig>` → `<kid>`, WITHOUT verifying anything.
 *
 *  Diagnosis only: `doctor` has to name the `kid` of a token whose key is NOT
 *  pinned, which is precisely the case where the verifier declines to hand one
 *  back. Never call this to decide trust. */
export function entitlementTokenKid(token: string | null): string | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1' || parts[1].length === 0) return null;
  return parts[1];
}

function activationLabel(decision: ActivationDecision, state: AccountState): string {
  if (decision.ok) {
    switch (decision.step) {
      case 'perpetual':
        return 'perpetual';
      case 'token_valid':
        return `valid until ${decision.payload.valid_until}`;
      case 'grace': {
        const last = state.last_refresh_at === null ? Number.NaN : Date.parse(state.last_refresh_at);
        const until = Number.isFinite(last) ? new Date(last + ACTIVATION_GRACE_MS).toISOString() : 'unknown';
        return `in grace until ${until}`;
      }
    }
  }
  switch (decision.step) {
    case 'no_token':
    case 'signature':
      return 'not activated';
    case 'unpinned_kid':
      return 'update required';
    case 'expired':
      return 'expired';
  }
}

function grantLines(state: AccountState, keys: PinnedKeySet): string[] {
  if (!state.entitlement_token) return ['  Grants: none cached'];
  const verified = verifyEntitlementToken(state.entitlement_token, keys.keys);
  if (!verified.ok) return [`  Grants: unreadable (${verified.reason})`];
  if (verified.payload.grants.length === 0) return ['  Grants: none'];
  return ['  Grants:', ...verified.payload.grants.map((g) => `    ${formatGrant(g)}`)];
}

function formatGrant(grant: EntitlementGrant): string {
  const features = grant.features && grant.features.length > 0 ? grant.features.join(', ') : 'none';
  const expiry = grant.expires === null ? 'no expiry' : `expires ${grant.expires}`;
  return `${grant.product} · ${grant.type} · features: ${features} · ${expiry}`;
}

function cachedGrants(state: AccountState, keys: PinnedKeySet): EntitlementGrant[] {
  if (!state.entitlement_token) return [];
  const verified = verifyEntitlementToken(state.entitlement_token, keys.keys);
  return verified.ok ? [...verified.payload.grants] : [];
}

// ---------------------------------------------------------------------------
// Access-token acquisition
// ---------------------------------------------------------------------------

/**
 * The Bearer token the `account` subcommands need.
 *
 * A one-shot CLI process starts with an empty in-memory access token by
 * definition (the 15-minute JWT is never written to disk), so the FIRST read
 * misses and a user-initiated rotation mints one. `refreshEntitlementsNow` and
 * not `maybeRefresh`: these verbs are gestures, and a user who just typed
 * `wigolo account` must not be told to come back tomorrow because an automatic
 * attempt already spent today's throttle slot.
 */
async function acquireAccessToken(
  dataDir: string,
  client: AccountsClient,
  nowMs: () => number,
): Promise<{ token: string } | { error: string }> {
  const cached = getAccessToken({ dataDir }, nowMs());
  if (cached) return { token: cached };

  const outcome = await refreshEntitlementsNow({ dataDir, client, nowMs });
  if (outcome.status === 'no_credential') {
    return { error: 'Not signed in on this machine — run `wigolo login` first.' };
  }
  if (outcome.status === 'needs_relogin') {
    return { error: 'Your sign-in is no longer valid — run `wigolo login` to reconnect.' };
  }
  const minted = getAccessToken({ dataDir }, nowMs());
  if (!minted) {
    return { error: 'Could not reach the accounts service — check your connection and try again.' };
  }
  return { token: minted };
}

// ---------------------------------------------------------------------------
// register / login
// ---------------------------------------------------------------------------

interface SignInOptions {
  /** `register` shows the served disclosure and asks for marketing consent. */
  readonly withConsent: boolean;
}

/**
 * The shared request-code → verify flow.
 *
 * THE ONE DIFFERENCE THAT MATTERS: `login` never sends `marketing_consent`.
 * PX1 applies its creation-only default when the field is ABSENT, so sending
 * even a truthful `false` on a sign-in would overwrite a withdrawal the user
 * made through the emailed unsubscribe link. `register` is the only verb that
 * may carry the field, and it carries what the toggle answered.
 */
async function runSignIn(
  verb: 'register' | 'login',
  args: readonly string[],
  deps: Required<Pick<AccountCliDeps, 'dataDir' | 'env' | 'nowMs'>> & {
    client: AccountsClient;
    stderr: NodeJS.WritableStream;
    stdout: NodeJS.WritableStream;
    prompter: LinePrompter;
  },
  options: SignInOptions,
): Promise<number> {
  const { dataDir, client, stderr, stdout, prompter, nowMs } = deps;
  const json = args.includes('--json');
  const write = (line: string): void => { stderr.write(`${line}\n`); };

  const store = new AccountStateStore(dataDir);
  // Read BEFORE verify: "account created" vs "signed in" is keyed on local
  // prior state only. The verify response does not flag creation and we do not
  // extend the PX1 contract to make it.
  const priorState = store.read();

  let email = flagValue(args, '--email');
  if (!email) email = await prompter.ask('Email: ');
  if (email === null) {
    write('No email address given.');
    return 1;
  }
  email = email.trim();
  if (!looksLikeEmail(email)) {
    write('That does not look like an email address.');
    return 1;
  }

  const requested = await client.requestCode(email);
  if (!requested.ok) {
    write(`Could not request a sign-in code: ${describeFailure(requested.code, requested.message)}`);
    return 1;
  }
  write('Check your email for the sign-in code.');

  const code = await prompter.ask('Sign-in code: ');
  if (code === null || code.trim().length === 0) {
    write('No sign-in code given.');
    return 1;
  }

  let marketingConsent: boolean | undefined;
  let disclosureVersion: string | null = priorState.disclosure_version;

  if (options.withConsent) {
    // The disclosure is SERVED, never client-bundled (PX1 §9). If we cannot
    // fetch it we cannot show it, and creating an account without showing the
    // wording the service is publishing is not a thing this command may do —
    // so the flow stops rather than degrading to a summary of our own.
    const disclosure = await client.telemetryDisclosure();
    if (!disclosure.ok) {
      write('Could not load the telemetry disclosure from the accounts service.');
      write('Registration stopped — nothing was created. Try again when the service is reachable.');
      return 1;
    }
    write('');
    write(disclosure.data.text);
    write('');
    disclosureVersion = disclosure.data.version;

    const answer = await prompter.ask('Send me occasional product updates by email? [Y/n] ');
    marketingConsent = parseYesNo(answer, true);
  }

  const verified = await client.verify({
    email,
    code: code.trim(),
    ...(marketingConsent === undefined ? {} : { marketingConsent }),
  });
  if (!verified.ok) {
    write(`Sign-in failed: ${describeFailure(verified.code, verified.message)}`);
    return 1;
  }

  await storeRefreshToken(verified.data.refresh_token, { dataDir });
  setAccessToken(verified.data.access_token, verified.data.access_expires_in_s, { dataDir }, nowMs());
  store.write({
    account_id: verified.data.account.id,
    email: verified.data.account.email,
    refresh_expires_at: verified.data.refresh_expires_at,
    needs_relogin: false,
    ...(disclosureVersion === null ? {} : { disclosure_version: disclosureVersion }),
    ...(marketingConsent === undefined ? {} : { marketing_consent: marketingConsent }),
  });

  const entitlement = await client.entitlementsToken(verified.data.access_token);
  if (!entitlement.ok) {
    // The credential is stored, so a retry is one command — but the install is
    // NOT activated until a grant is cached, and saying "you're all set" here
    // would be a lie the very next tool call exposes.
    write('Signed in, but your entitlement could not be fetched — wigolo is not activated yet.');
    write('Run `wigolo login` again once the accounts service is reachable.');
    log.warn('entitlement fetch failed during sign-in', { code: entitlement.code });
    return 1;
  }
  store.write({
    entitlement_token: entitlement.data.token,
    last_refresh_at: new Date(nowMs()).toISOString(),
  });

  const created = verb === 'register' && priorState.account_id === null;
  const headline = created ? 'Account created.' : 'Signed in.';

  if (json) {
    stdout.write(
      `${JSON.stringify({
        status: 'ok',
        action: created ? 'created' : 'signed_in',
        account_id: verified.data.account.id,
        email: verified.data.account.email,
        ...(marketingConsent === undefined ? {} : { marketing_consent: marketingConsent }),
        ...(disclosureVersion === null ? {} : { disclosure_version: disclosureVersion }),
      })}\n`,
    );
  }

  write(headline);
  if (!options.withConsent) {
    write('wigolo sends usage and reliability telemetry, keyed to your account.');
  }
  write('Telemetry is on by default — turn it off any time with WIGOLO_TELEMETRY=off.');
  return 0;
}

function parseYesNo(answer: string | null, fallback: boolean): boolean {
  if (answer === null) return fallback;
  const v = answer.trim().toLowerCase();
  if (v.length === 0) return fallback;
  return v === 'y' || v === 'yes';
}

/** One human sentence per failure class. The service's own `message` is
 *  appended only when it carries something a code does not. */
function describeFailure(code: string, message: string): string {
  const detail = message.trim();
  return detail.length > 0 ? `${code} (${detail})` : code;
}

// ---------------------------------------------------------------------------
// logout
// ---------------------------------------------------------------------------

/**
 * LOCAL-ONLY, AND SAID SO (A-212-8). PX1 exposes no revocation endpoint and its
 * contract is fixed input for PX2, so this deletes the credential on this
 * machine and the server-side refresh row ages out on its own. Claiming a
 * server-side sign-out we do not perform would be the one thing worse than the
 * gap itself.
 */
async function runLogout(
  args: readonly string[],
  deps: { dataDir: string; stderr: NodeJS.WritableStream; stdout: NodeJS.WritableStream },
): Promise<number> {
  const { dataDir, stderr, stdout } = deps;
  await deleteRefreshToken({ dataDir });
  clearAccessToken({ dataDir });
  new AccountStateStore(dataDir).clear();

  if (args.includes('--json')) {
    stdout.write(`${JSON.stringify({ status: 'ok', scope: 'local' })}\n`);
  }
  stderr.write('Signed out on this machine.\n');
  stderr.write('This clears the local credential only; it does not sign out other machines.\n');
  return 0;
}

// ---------------------------------------------------------------------------
// whoami
// ---------------------------------------------------------------------------

/** Fully OFFLINE. `whoami` answers from cached state so it stays useful on a
 *  machine with no connection — which is the machine most likely to be asking. */
function runWhoami(
  args: readonly string[],
  deps: {
    dataDir: string;
    accountsUrl: string;
    env: NodeJS.ProcessEnv;
    nowMs: () => number;
    stderr: NodeJS.WritableStream;
    stdout: NodeJS.WritableStream;
  },
): number {
  const { dataDir, accountsUrl, env, nowMs, stderr, stdout } = deps;
  const json = args.includes('--json');
  const state = new AccountStateStore(dataDir).read();
  const keys = resolvePinnedKeys(env);
  const decision = evaluateActivation({ state, keys: keys.keys }, nowMs());
  const activation = activationLabel(decision, state);
  const neverActivated = !decision.ok && (decision.step === 'no_token' || decision.step === 'signature');

  if (json) {
    stdout.write(
      `${JSON.stringify({
        status: neverActivated ? 'not_activated' : 'ok',
        email: state.email,
        account_id: state.account_id,
        activation,
        needs_relogin: state.needs_relogin,
        refresh_expires_at: state.refresh_expires_at,
        custom_verification_key: keys.overrideActive,
      })}\n`,
    );
  }

  // BEFORE the not-signed-in early return, deliberately. A machine that has
  // never signed in is the one about to POST an email address to this host and
  // read a sign-in code back off it, so that arm is the one that can least
  // afford to omit where the address points.
  const urlOverride = accountsUrlOverride(accountsUrl, env);
  if (urlOverride !== null) stderr.write(`${urlOverride.notice}\n`);

  if (state.account_id === null && neverActivated) {
    stderr.write('Not signed in — run `wigolo register` to create an account.\n');
    return 1;
  }

  stderr.write(`Email:      ${state.email ?? 'unknown'}\n`);
  stderr.write(`Account:    ${state.account_id ?? 'unknown'}\n`);
  stderr.write(`Activation: ${activation}\n`);
  if (state.needs_relogin) {
    stderr.write('Sign-in needed: this machine\'s credential is no longer valid — run `wigolo login`.\n');
  }
  if (state.refresh_expires_at !== null) {
    stderr.write(`Sign-in valid until: ${state.refresh_expires_at}\n`);
  }
  if (keys.notice !== null) {
    stderr.write(`${keys.notice}\n`);
  }
  return neverActivated ? 1 : 0;
}

// ---------------------------------------------------------------------------
// account [export FILE | delete]
// ---------------------------------------------------------------------------

const DELETE_CONFIRMATION = 'DELETE';

async function runAccountSummary(
  args: readonly string[],
  deps: {
    dataDir: string;
    client: AccountsClient;
    env: NodeJS.ProcessEnv;
    nowMs: () => number;
    stderr: NodeJS.WritableStream;
    stdout: NodeJS.WritableStream;
  },
): Promise<number> {
  const { dataDir, client, env, nowMs, stderr, stdout } = deps;
  const json = args.includes('--json');
  const write = (line: string): void => { stderr.write(`${line}\n`); };

  const acquired = await acquireAccessToken(dataDir, client, nowMs);
  if ('error' in acquired) {
    write(acquired.error);
    return 1;
  }
  const summary = await client.account(acquired.token);
  if (!summary.ok) {
    write(`Could not load your account: ${describeFailure(summary.code, summary.message)}`);
    return 1;
  }

  const state = new AccountStateStore(dataDir).read();
  const keys = resolvePinnedKeys(env);
  const telemetry = isTelemetryEnabled() ? 'on' : 'off';

  if (json) {
    stdout.write(
      `${JSON.stringify({
        status: 'ok',
        account: {
          id: summary.data.id,
          email: summary.data.email,
          created_at: summary.data.created_at,
          marketing_consent: summary.data.consent.marketing,
          disclosure_version: summary.data.telemetry.disclosure_version,
        },
        grants: cachedGrants(state, keys),
        telemetry,
      })}\n`,
    );
  }

  write(`Email:      ${summary.data.email}`);
  write(`Account:    ${summary.data.id}`);
  write(`Created:    ${summary.data.created_at}`);
  write(`Product-update emails: ${summary.data.consent.marketing ? 'yes' : 'no'}`);
  write(`Telemetry disclosure shown: ${summary.data.telemetry.disclosure_version ?? 'none'}`);
  write(
    telemetry === 'on'
      ? 'Telemetry: on — set WIGOLO_TELEMETRY=off to turn it off'
      : 'Telemetry: off',
  );
  for (const line of grantLines(state, keys)) write(line);
  // The withdrawal gap, said out loud rather than implied: PX1's only
  // consent-write surfaces are the field on verify and the emailed unsubscribe
  // link, so there is no CLI path and we do not invent an endpoint (A-212-8).
  write('Change product-update emails from the unsubscribe link in any wigolo email.');
  return 0;
}

async function runAccountExport(
  args: readonly string[],
  file: string | undefined,
  deps: { dataDir: string; client: AccountsClient; nowMs: () => number; stderr: NodeJS.WritableStream; stdout: NodeJS.WritableStream },
): Promise<number> {
  const { dataDir, client, nowMs, stderr, stdout } = deps;
  const write = (line: string): void => { stderr.write(`${line}\n`); };
  if (!file || file.startsWith('-')) {
    write('Usage: wigolo account export <file>');
    return 1;
  }

  const acquired = await acquireAccessToken(dataDir, client, nowMs);
  if ('error' in acquired) {
    write(acquired.error);
    return 1;
  }
  const exported = await client.accountExport(acquired.token);
  if (!exported.ok) {
    write(`Export failed: ${describeFailure(exported.code, exported.message)}`);
    return 1;
  }
  try {
    writeFileSync(file, `${JSON.stringify(exported.data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    write(`Could not write ${file}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  if (args.includes('--json')) {
    stdout.write(`${JSON.stringify({ status: 'ok', file })}\n`);
  }
  write(`Wrote your account export to ${file}`);
  return 0;
}

async function runAccountDelete(
  args: readonly string[],
  deps: {
    dataDir: string;
    client: AccountsClient;
    nowMs: () => number;
    prompter: LinePrompter;
    stderr: NodeJS.WritableStream;
    stdout: NodeJS.WritableStream;
  },
): Promise<number> {
  const { dataDir, client, nowMs, prompter, stderr, stdout } = deps;
  const write = (line: string): void => { stderr.write(`${line}\n`); };

  write('This permanently deletes your wigolo account and everything the service holds for it.');
  const answer = await prompter.ask(`Type ${DELETE_CONFIRMATION} to confirm: `);
  // The literal, exactly — no case folding and no "d"/"yes" shorthand. The
  // whole point of a typed confirmation is that it cannot be answered by
  // reflex, and a forgiving match gives that back.
  if (answer === null || answer.trim() !== DELETE_CONFIRMATION) {
    write('Not deleted.');
    return 1;
  }

  const acquired = await acquireAccessToken(dataDir, client, nowMs);
  if ('error' in acquired) {
    write(acquired.error);
    return 1;
  }
  const deleted = await client.deleteAccount(acquired.token);
  if (!deleted.ok) {
    write(`Could not delete your account: ${describeFailure(deleted.code, deleted.message)}`);
    return 1;
  }

  await deleteRefreshToken({ dataDir });
  clearAccessToken({ dataDir });
  new AccountStateStore(dataDir).clear();

  if (args.includes('--json')) {
    stdout.write(`${JSON.stringify({ status: 'ok', deleted: true })}\n`);
  }
  write('Account deleted, and this machine signed out.');
  return 0;
}

// ---------------------------------------------------------------------------
// doctor section
// ---------------------------------------------------------------------------

export interface AccountDoctorInput {
  readonly state: AccountState;
  readonly keys: PinnedKeySet;
  readonly nowMs: number;
  /** `kid`s from `GET /entitlements/keys`, or `null` when the list was not
   *  fetched or the service could not be reached. DIAGNOSIS ONLY — pinning
   *  stays the trust root and nothing here is ever promoted to a key. */
  readonly serviceKids: readonly string[] | null;
  /** The account service address override in force, or `null` on the default.
   *  REQUIRED rather than optional: a surface that forgets it is a surface that
   *  reports a healthy account while the credentials go somewhere else. */
  readonly accountsUrl: AccountsUrlOverride | null;
}

/**
 * The `doctor` account section (mini-spec §5).
 *
 * Its whole job is making a ROTATION MISS diagnosable in band: the cached
 * token's `kid`, the `kid`s this build pins, and the `kid`s the service
 * publishes, side by side. When the first is absent from the second but present
 * in the third, the user needs a wigolo update — a conclusion no single one of
 * the three lines supports on its own.
 */
export function buildAccountDoctorLines(input: AccountDoctorInput): string[] {
  const { state, keys, nowMs, serviceKids, accountsUrl } = input;
  const lines: string[] = [];

  if (state.account_id === null) {
    lines.push('  Not signed in (run `wigolo register`)');
  } else {
    lines.push(`  Signed in: ${state.email ?? 'unknown'} (${state.account_id})`);
  }

  const decision = evaluateActivation({ state, keys: keys.keys }, nowMs);
  lines.push(`  Activation: ${activationLabel(decision, state)}`);
  if (state.needs_relogin) lines.push('  Sign-in needed: run `wigolo login`');

  const pinnedKids = keys.keys.map((k) => k.kid);
  lines.push(`  Verification keys pinned: ${pinnedKids.length > 0 ? pinnedKids.join(', ') : 'none'}`);

  const tokenKid = entitlementTokenKid(state.entitlement_token);
  if (tokenKid === null) {
    lines.push('  Entitlement key: no cached entitlement');
  } else if (pinnedKids.includes(tokenKid)) {
    lines.push(`  Entitlement key: ${tokenKid} (pinned)`);
  } else if (serviceKids !== null && serviceKids.includes(tokenKid)) {
    lines.push(`  Entitlement key: ${tokenKid} — published by the service but NOT pinned by this build`);
    lines.push('  Update wigolo, then run `wigolo login`.');
  } else {
    lines.push(`  Entitlement key: ${tokenKid} — not pinned by this build`);
  }

  lines.push(
    `  Service keys: ${serviceKids === null ? 'not checked' : serviceKids.length > 0 ? serviceKids.join(', ') : 'none published'}`,
  );
  if (keys.notice !== null) lines.push(`  ${keys.notice}`);
  if (accountsUrl !== null) lines.push(`  ${accountsUrl.notice}`);
  return lines;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runAccountCommand(
  verb: AccountVerb,
  args: readonly string[],
  deps: AccountCliDeps = {},
): Promise<number> {
  const dataDir = deps.dataDir ?? getConfig().dataDir;
  const env = deps.env ?? process.env;
  const nowMs = deps.nowMs ?? Date.now;
  const stderr = deps.stderr ?? process.stderr;
  const stdout = deps.stdout ?? process.stdout;
  // Resolved ONCE and shared: the address the notice names and the address the
  // client posts to must be the same string, or the notice is worse than absent.
  const accountsUrl = deps.accountsUrl ?? getConfig().accountsUrl;
  const client = deps.client ?? new AccountsClient({ baseUrl: accountsUrl });

  if (verb === 'whoami') {
    return runWhoami(args, { dataDir, accountsUrl, env, nowMs, stderr, stdout });
  }
  if (verb === 'logout') {
    return runLogout(args, { dataDir, stderr, stdout });
  }

  const prompter = createLinePrompter(deps.input ?? process.stdin, stderr);
  try {
    if (verb === 'register' || verb === 'login') {
      return await runSignIn(
        verb,
        args,
        { dataDir, env, nowMs, client, stderr, stdout, prompter },
        { withConsent: verb === 'register' },
      );
    }

    const sub = args.find((a) => !a.startsWith('-')) ?? '';
    switch (sub) {
      case '':
        return await runAccountSummary(args, { dataDir, client, env, nowMs, stderr, stdout });
      case 'export': {
        const rest = args.filter((a) => !a.startsWith('-'));
        return await runAccountExport(args, rest[1], { dataDir, client, nowMs, stderr, stdout });
      }
      case 'delete':
        return await runAccountDelete(args, { dataDir, client, nowMs, prompter, stderr, stdout });
      default:
        stderr.write(`wigolo account: unknown subcommand '${sub}'\n`);
        stderr.write('Usage: wigolo account [export <file>|delete] [--json]\n');
        return 1;
    }
  } finally {
    prompter.close();
  }
}
