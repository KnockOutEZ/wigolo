/**
 * HTTP client for the accounts service (PX1 mini-spec §2).
 *
 * Two properties are load-bearing and are the reason this is a hand-rolled
 * client rather than a generated one:
 *
 *  1. **It never throws into a tool path.** Every method answers with an
 *     `AccountsResult` discriminated union. A gate, a refresh timer or a
 *     telemetry flush that calls this can branch; it can never be unwound by a
 *     rejected promise from a service that happens to be down.
 *  2. **The failure taxonomy survives.** PX1's uniform error envelope
 *     (`{error:{code,message,retry_after_s?}}`) carries a CLOSED set of machine
 *     codes per endpoint, and the refresh policy consumes four of them
 *     (`invalid_refresh` / `refresh_reused` / `refresh_expired` /
 *     `invalid_token`) with materially different behaviour. Collapsing them to
 *     "auth failed" would silently turn a benign concurrent-refresh race into a
 *     forced re-login, so the code is carried through verbatim and a response
 *     that does NOT carry a well-formed envelope is classified `malformed`
 *     rather than being guessed at.
 *
 * Transport is bare global `fetch` + `AbortSignal.timeout` — the convention for
 * non-page calls in this codebase (engine adapters, the LLM run, health
 * probes). The base URL is threaded explicitly from `config.accountsUrl`; this
 * module never reads config, which is also what keeps `config.ts` free to
 * import the account constants without a cycle.
 */

import { createLogger } from '../logger.js';
import { accountsTransportRefusal } from './accounts-url-policy.js';
import { AUTH_TIMEOUT_MS, EXPORT_TIMEOUT_MS } from './constants.js';

const log = createLogger('account');

/** Injectable transport so tests never need a live socket. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface AccountsClientOpts {
  /** Base URL of the accounts service, e.g. `http://127.0.0.1:8787`. */
  baseUrl: string;
  /** Defaults to global `fetch`. Injected in tests and by the daemon's pooled agent. */
  fetchImpl?: FetchLike;
  /** Environment-only account transport overrides. Injected in tests. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Why a failure could not be attributed to a service decision.
 *
 * `http` means the service answered with a well-formed error envelope and
 * `code` is ITS code. Everything else means the code is ours, and a caller
 * MUST NOT treat it as a statement about the credential.
 */
export type AccountsFailureKind = 'http' | 'network' | 'timeout' | 'malformed' | 'policy';

export interface AccountsFailure {
  ok: false;
  /** HTTP status when one was received; null when the request never completed. */
  status: number | null;
  kind: AccountsFailureKind;
  /** Service error code for `kind: 'http'`; one of the synthetic codes below otherwise. */
  code: string;
  message: string;
  retryAfterS?: number;
}

export interface AccountsSuccess<T> {
  ok: true;
  status: number;
  data: T;
}

export type AccountsResult<T> = AccountsSuccess<T> | AccountsFailure;

/** Synthetic codes. Deliberately disjoint from every PX1 §2 code so a caller
 *  matching on the taxonomy can never mistake one of ours for a service verdict. */
export const CLIENT_TIMEOUT = 'client_timeout';
export const CLIENT_NETWORK = 'client_network';
export const CLIENT_MALFORMED = 'client_malformed';
export const CLIENT_INSECURE_TRANSPORT = 'client_insecure_transport';

// --- Response shapes actually consumed by core (PX1 §2) --------------------

export interface AccountSummary {
  id: string;
  email: string;
  created_at: string;
}

export interface VerifyResponse {
  account: AccountSummary;
  access_token: string;
  access_expires_in_s: number;
  refresh_token: string;
  refresh_expires_at: string;
  telemetry_disclosure: { text: string; version: string };
}

export interface RefreshResponse {
  access_token: string;
  access_expires_in_s: number;
  refresh_token: string;
  refresh_expires_at: string;
}

export interface EntitlementTokenResponse {
  token: string;
  valid_until: string;
  kid: string;
}

export interface EntitlementKeysResponse {
  keys: Array<{ kid: string; public_key: string; active: boolean }>;
}

export interface AccountResponse {
  id: string;
  email: string;
  created_at: string;
  email_verified_at: string | null;
  consent: { marketing: boolean; marketing_updated_at: string | null };
  telemetry: { disclosure_version: string | null; disclosed_at: string | null };
}

export interface TelemetryDisclosureResponse {
  text: string;
  version: string;
  updated_at: string;
}

export interface TelemetryBatchResponse {
  accepted: number;
}

// --- Narrow runtime validators ---------------------------------------------
//
// Core carries no schema library, and a 200 whose body is the wrong shape has
// to fail as loudly as a 500 — otherwise `undefined` propagates into the token
// store and we persist a credential that is not one.

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): v is string {
  return typeof v === 'string';
}

function hasStrings(v: unknown, keys: readonly string[]): boolean {
  if (!isObj(v)) return false;
  return keys.every((k) => str(v[k]));
}

// --- Error envelope ---------------------------------------------------------

interface ErrorEnvelope {
  code: string;
  message: string;
  retryAfterS?: number;
}

/** Parse PX1's uniform error shape. Returns null when the body is not one. */
function parseErrorEnvelope(body: unknown): ErrorEnvelope | null {
  if (!isObj(body)) return null;
  const err = body['error'];
  if (!isObj(err)) return null;
  if (!str(err['code'])) return null;
  const message = str(err['message']) ? err['message'] : '';
  const retry = err['retry_after_s'];
  return {
    code: err['code'],
    message,
    ...(typeof retry === 'number' && Number.isFinite(retry) ? { retryAfterS: retry } : {}),
  };
}

function malformed(status: number | null, message: string): AccountsFailure {
  return { ok: false, status, kind: 'malformed', code: CLIENT_MALFORMED, message };
}

/**
 * Classify a thrown transport error.
 *
 * `AbortSignal.timeout` rejects with a `TimeoutError` DOMException; an aborted
 * request rejects with `AbortError`. Both are separated from a generic network
 * failure because the refresh policy treats a timeout on a one-shot as "proceed
 * anyway", and a caller may want to distinguish "server was slow" from "server
 * was unreachable" in `doctor` output.
 */
function classifyThrow(err: unknown): AccountsFailure {
  const name = isObj(err) && str(err['name']) ? err['name'] : '';
  const message = err instanceof Error ? err.message : String(err);
  if (name === 'TimeoutError' || name === 'AbortError') {
    return { ok: false, status: null, kind: 'timeout', code: CLIENT_TIMEOUT, message };
  }
  return { ok: false, status: null, kind: 'network', code: CLIENT_NETWORK, message };
}

interface RequestSpec {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  timeoutMs: number;
  body?: unknown;
  accessToken?: string;
  /** Credentials carried in the body rather than the Authorization header. */
  credentialBody?: true;
}

export class AccountsClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly env: NodeJS.ProcessEnv;

  constructor(opts: AccountsClientOpts) {
    // A trailing slash would produce `//auth/verify`, which some proxies 404.
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.env = opts.env ?? process.env;
  }

  /**
   * Single funnel for every endpoint: one place that owns timeouts, header
   * construction, envelope parsing and the never-throw guarantee.
   *
   * `parse` runs only on a 2xx and decides whether the success body is usable;
   * returning `null` from it means "the service answered 200 with something we
   * cannot act on", which is a `malformed` failure, not a success.
   */
  private async request<T>(spec: RequestSpec, parse: (body: unknown) => T | null): Promise<AccountsResult<T>> {
    const credentialBearing = spec.credentialBody === true || spec.accessToken !== undefined;
    const transportRefusal = credentialBearing ? accountsTransportRefusal(this.baseUrl, this.env) : null;
    if (transportRefusal !== null) {
      return {
        ok: false,
        status: null,
        kind: 'policy',
        code: CLIENT_INSECURE_TRANSPORT,
        message: transportRefusal,
      };
    }

    const url = `${this.baseUrl}${spec.path}`;
    const headers: Record<string, string> = { accept: 'application/json' };
    if (spec.body !== undefined) headers['content-type'] = 'application/json';
    if (spec.accessToken) headers['authorization'] = `Bearer ${spec.accessToken}`;

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: spec.method,
        headers,
        ...(spec.body !== undefined ? { body: JSON.stringify(spec.body) } : {}),
        signal: AbortSignal.timeout(spec.timeoutMs),
      });
    } catch (err) {
      const failure = classifyThrow(err);
      // Never log the body or the Authorization header — only the endpoint.
      log.debug('accounts request failed', { path: spec.path, kind: failure.kind });
      return failure;
    }

    // 204 carries no body by contract (DELETE /account).
    const raw = res.status === 204 ? '' : await res.text().catch(() => '');
    let body: unknown = undefined;
    if (raw.length > 0) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = undefined;
      }
    }

    if (!res.ok) {
      const envelope = parseErrorEnvelope(body);
      if (!envelope) {
        return malformed(res.status, `accounts ${spec.path}: ${res.status} without an error envelope`);
      }
      log.debug('accounts request rejected', { path: spec.path, status: res.status, code: envelope.code });
      return {
        ok: false,
        status: res.status,
        kind: 'http',
        code: envelope.code,
        message: envelope.message,
        ...(envelope.retryAfterS !== undefined ? { retryAfterS: envelope.retryAfterS } : {}),
      };
    }

    const parsed = parse(body);
    if (parsed === null) {
      return malformed(res.status, `accounts ${spec.path}: unexpected success body`);
    }
    return { ok: true, status: res.status, data: parsed };
  }

  // --- Endpoint 1 -----------------------------------------------------------

  /** `POST /auth/request-code`. 202 on any well-formed email — never reveals existence. */
  async requestCode(email: string): Promise<AccountsResult<Record<string, never>>> {
    return this.request(
      { method: 'POST', path: '/auth/request-code', timeoutMs: AUTH_TIMEOUT_MS, body: { email } },
      () => ({}) as Record<string, never>,
    );
  }

  // --- Endpoint 2 -----------------------------------------------------------

  /** `POST /auth/verify`. `marketing_consent` is omitted, not defaulted: PX1 applies
   *  its creation-only default when the field is ABSENT, and sending `false` would
   *  silently overwrite an existing account's consent. */
  async verify(input: {
    email: string;
    code: string;
    marketingConsent?: boolean;
  }): Promise<AccountsResult<VerifyResponse>> {
    const body: Record<string, unknown> = { email: input.email, code: input.code };
    if (input.marketingConsent !== undefined) body['marketing_consent'] = input.marketingConsent;
    return this.request({
      method: 'POST',
      path: '/auth/verify',
      timeoutMs: AUTH_TIMEOUT_MS,
      body,
      credentialBody: true,
    }, (b) => {
      if (!isObj(b)) return null;
      if (!hasStrings(b, ['access_token', 'refresh_token', 'refresh_expires_at'])) return null;
      if (typeof b['access_expires_in_s'] !== 'number') return null;
      if (!hasStrings(b['account'], ['id', 'email', 'created_at'])) return null;
      if (!hasStrings(b['telemetry_disclosure'], ['text', 'version'])) return null;
      return b as unknown as VerifyResponse;
    });
  }

  // --- Endpoint 3 -----------------------------------------------------------

  /** `POST /auth/refresh`. Rotating: the response's `refresh_token` REPLACES the
   *  presented one, and failing to persist it strands the install. */
  async refresh(refreshToken: string): Promise<AccountsResult<RefreshResponse>> {
    return this.request(
      {
        method: 'POST',
        path: '/auth/refresh',
        timeoutMs: AUTH_TIMEOUT_MS,
        body: { refresh_token: refreshToken },
        credentialBody: true,
      },
      (b) => {
        if (!hasStrings(b, ['access_token', 'refresh_token', 'refresh_expires_at'])) return null;
        if (!isObj(b) || typeof b['access_expires_in_s'] !== 'number') return null;
        return b as unknown as RefreshResponse;
      },
    );
  }

  // --- Endpoint 4 -----------------------------------------------------------

  /** `GET /entitlements/token` (Bearer). */
  async entitlementsToken(accessToken: string): Promise<AccountsResult<EntitlementTokenResponse>> {
    return this.request(
      { method: 'GET', path: '/entitlements/token', timeoutMs: AUTH_TIMEOUT_MS, accessToken },
      (b) => (hasStrings(b, ['token', 'valid_until', 'kid']) ? (b as unknown as EntitlementTokenResponse) : null),
    );
  }

  // --- Endpoint 13 ----------------------------------------------------------

  /** `GET /entitlements/keys` (public). A DIAGNOSTIC surface only — pinning stays
   *  the trust root, so nothing here may ever be promoted to a verification key. */
  async entitlementsKeys(): Promise<AccountsResult<EntitlementKeysResponse>> {
    return this.request({ method: 'GET', path: '/entitlements/keys', timeoutMs: AUTH_TIMEOUT_MS }, (b) => {
      if (!isObj(b) || !Array.isArray(b['keys'])) return null;
      for (const k of b['keys']) {
        if (!hasStrings(k, ['kid', 'public_key'])) return null;
        if (typeof (k as Record<string, unknown>)['active'] !== 'boolean') return null;
      }
      return b as unknown as EntitlementKeysResponse;
    });
  }

  // --- Endpoint 6 -----------------------------------------------------------

  /** `GET /account` (Bearer). */
  async account(accessToken: string): Promise<AccountsResult<AccountResponse>> {
    return this.request({ method: 'GET', path: '/account', timeoutMs: AUTH_TIMEOUT_MS, accessToken }, (b) => {
      if (!hasStrings(b, ['id', 'email', 'created_at'])) return null;
      if (!isObj(b) || !isObj(b['consent']) || !isObj(b['telemetry'])) return null;
      return b as unknown as AccountResponse;
    });
  }

  // --- Endpoint 7 -----------------------------------------------------------

  /** `GET /account/export` (Bearer). Longer timeout: the service assembles the
   *  whole account. The document is opaque here — core forwards it to a file. */
  async accountExport(accessToken: string): Promise<AccountsResult<unknown>> {
    return this.request(
      { method: 'GET', path: '/account/export', timeoutMs: EXPORT_TIMEOUT_MS, accessToken },
      (b) => (b === undefined ? null : b),
    );
  }

  // --- Endpoint 8 -----------------------------------------------------------

  /** `DELETE /account` (Bearer). 204, no body. */
  async deleteAccount(accessToken: string): Promise<AccountsResult<Record<string, never>>> {
    return this.request(
      { method: 'DELETE', path: '/account', timeoutMs: AUTH_TIMEOUT_MS, accessToken },
      () => ({}) as Record<string, never>,
    );
  }

  // --- Endpoint 11 ----------------------------------------------------------

  /** `GET /legal/telemetry-disclosure` (public). Clients always render the SERVED
   *  wording; core never ships its own copy of this text. */
  async telemetryDisclosure(): Promise<AccountsResult<TelemetryDisclosureResponse>> {
    return this.request({ method: 'GET', path: '/legal/telemetry-disclosure', timeoutMs: AUTH_TIMEOUT_MS }, (b) =>
      hasStrings(b, ['text', 'version', 'updated_at']) ? (b as unknown as TelemetryDisclosureResponse) : null,
    );
  }

  // --- Endpoint 5 -----------------------------------------------------------

  /** `POST /telemetry/batch` (Bearer). The envelope is built by the telemetry
   *  client (slice E/F); this is the transport only. */
  async telemetryBatch(accessToken: string, envelope: unknown): Promise<AccountsResult<TelemetryBatchResponse>> {
    return this.request(
      { method: 'POST', path: '/telemetry/batch', timeoutMs: AUTH_TIMEOUT_MS, body: envelope, accessToken },
      (b) => (isObj(b) && typeof b['accepted'] === 'number' ? (b as unknown as TelemetryBatchResponse) : null),
    );
  }
}
