/**
 * The shared companion-contract FIXTURE SET (`wigolo/companion-contract/fixtures`).
 *
 * Plain data, no behaviour, no I/O. Both repositories' contract tests import THIS set rather than
 * minting their own: the wire is agreed by two codebases that ship on different clocks, so a copied
 * handshake arm or a hand-typed broker op is a place where one side can start believing something the
 * other never said. A test that builds its own inputs proves its own module self-consistent; only a
 * shared set proves the two sides agree.
 *
 * WHY IT SITS BESIDE THE CONTRACT AND NOT IN A TEST DIRECTORY. `tests/` is not published, and the
 * consumer is the other repository. The set is therefore contract-adjacent source on its own subpath —
 * a deep key, not a wildcard — so the runtime barrel (`wigolo/companion-contract`) that the app ships
 * in production stays exactly the wire and carries none of this.
 *
 * WHAT IS AND IS NOT PINNED HERE. Every value is a literal. Nothing is computed by the functions these
 * fixtures are used to test — an expectation derived from its own subject agrees with any behaviour,
 * including a broken one. {@link HANDSHAKE_CASES} therefore carries a hand-written `expected` beside
 * each input pair, and it is a red here (not a silently-passing test) when {@link evaluateHandshake}'s
 * rules change without the wire's owners saying so.
 *
 * The synthetic versions below are deliberately NOT the live {@link COMPANION_CONTRACT_VERSION}: the
 * skew arms have to keep exercising MAJOR and MINOR skew after the real contract bumps, and an arm
 * written against the live pin stops testing skew the moment the pin moves. {@link PINNED_CONTRACT_VERSION}
 * is the one value that does track the pin, and core asserts the two are equal — that assertion is the
 * whole point of it, and it is what tells the app which contract core speaks.
 */
import type { CompanionHello, CompanionHelloApp, HandshakeResult } from './handshake.js';
import type {
  BrokerGrant,
  BrokerReadOp,
  BrokerRefusal,
  BrokerRevocation,
  BrokerWriteOp,
} from './broker.js';
import { STUDIO_FETCH_CAPABILITY } from './escalation.js';
import type { EscalationDecline, EscalationRequest, EscalationServed } from './escalation.js';
import type { SessionTargetRefusal, SessionTargetRequest } from './session-target.js';

/**
 * The contract version core ships, restated as data so the app can pin it without importing the
 * runtime barrel. Core asserts `COMPANION_CONTRACT_VERSION === PINNED_CONTRACT_VERSION`; a bump that
 * forgets this constant reds there rather than reaching the app as a silent version disagreement.
 */
export const PINNED_CONTRACT_VERSION = '1.0.0';

/**
 * §6 skew constants — the four schema heads every handshake arm is built from.
 *
 * `appMinimum` is the head the app declares it cannot run below; `current` is the head both sides
 * normally carry; `belowAppMinimum` and `aheadOfApp` are the two directions §6 rules on. They are
 * relative positions, not real migration numbers: what the wire cares about is the ORDERING, and an
 * arm written against a real head number would need editing every time a migration lands.
 */
export const SCHEMA_HEADS = Object.freeze({
  /** The app's declared floor — external below this is "update wigolo". */
  appMinimum: 16,
  /** The head both sides carry in the ordinary case. */
  current: 18,
  /** External is behind the app's floor. §6: pairing refused. */
  belowAppMinimum: 15,
  /** External is ahead of the head the app knows. §6: allowed iff broker wire MAJOR matches. */
  aheadOfApp: 20,
});

/**
 * Synthetic contract versions for the skew arms. Two MAJORs, three MINORs inside MAJOR 1 — enough to
 * exercise both directions of a MAJOR mismatch and both directions of a tolerated MINOR skew.
 */
export const CONTRACT_VERSIONS = Object.freeze({
  major1Low: '1.4.0',
  major1Mid: '1.7.0',
  major1High: '1.9.0',
  major2: '2.0.0',
});

/** One handshake arm: the two hellos, and the verdict §6 requires of them. */
export interface HandshakeCase {
  /** Stable id both repositories can name a failure by. */
  readonly id: string;
  /** What §6 rule this arm stands for, in one line. */
  readonly rule: string;
  readonly external: CompanionHello;
  readonly app: CompanionHelloApp;
  readonly expected: HandshakeResult;
}

function hello(contractVersion: string, schemaHead: number, capabilities: readonly string[] = []): CompanionHello {
  return { contractVersion, schemaHead, capabilities };
}

function appHello(
  contractVersion: string,
  schemaHead: number,
  minSchemaHead: number,
  capabilities: readonly string[] = [],
): CompanionHelloApp {
  return { contractVersion, schemaHead, minSchemaHead, capabilities };
}

/**
 * Every §6 arm, pinned once for both repositories.
 *
 * Iterating this set is what makes the two sides agree: a rule the app implements differently reds
 * against the same inputs core reds against, with the same id in the failure.
 */
export const HANDSHAKE_CASES: readonly HandshakeCase[] = Object.freeze([
  {
    id: 'major-mismatch-external-ahead',
    rule: 'contract MAJOR differs and external is newer — the app is the stale side',
    external: hello(CONTRACT_VERSIONS.major2, SCHEMA_HEADS.current),
    app: appHello(CONTRACT_VERSIONS.major1Low, SCHEMA_HEADS.current, SCHEMA_HEADS.appMinimum),
    expected: { ok: false, reason: 'contract_major_mismatch', hint: 'update_studio' },
  },
  {
    id: 'major-mismatch-app-ahead',
    rule: 'contract MAJOR differs and the app is newer — external core is the stale side',
    external: hello(CONTRACT_VERSIONS.major1Low, SCHEMA_HEADS.current),
    app: appHello(CONTRACT_VERSIONS.major2, SCHEMA_HEADS.current, SCHEMA_HEADS.appMinimum),
    expected: { ok: false, reason: 'contract_major_mismatch', hint: 'update_wigolo' },
  },
  {
    id: 'minor-skew-external-ahead',
    rule: 'MINOR is forward-compatible; unknown capability flags are ignored',
    external: hello(CONTRACT_VERSIONS.major1High, SCHEMA_HEADS.current, ['future-external-flag']),
    app: appHello(CONTRACT_VERSIONS.major1Low, SCHEMA_HEADS.current, SCHEMA_HEADS.appMinimum, [
      'future-app-flag',
    ]),
    expected: { ok: true },
  },
  {
    id: 'minor-skew-app-ahead',
    rule: 'MINOR skew is symmetric — the older side is not refused in either direction',
    external: hello(CONTRACT_VERSIONS.major1Low, SCHEMA_HEADS.current, ['future-external-flag']),
    app: appHello(CONTRACT_VERSIONS.major1High, SCHEMA_HEADS.current, SCHEMA_HEADS.appMinimum, [
      'future-app-flag',
    ]),
    expected: { ok: true },
  },
  {
    id: 'schema-below-app-minimum',
    rule: 'external head < the app minimum → refuse, "update wigolo"',
    external: hello(PINNED_CONTRACT_VERSION, SCHEMA_HEADS.belowAppMinimum),
    app: appHello(PINNED_CONTRACT_VERSION, SCHEMA_HEADS.current, SCHEMA_HEADS.appMinimum),
    expected: { ok: false, reason: 'schema_too_old', hint: 'update_wigolo' },
  },
  {
    id: 'schema-exactly-app-minimum',
    rule: 'the floor is inclusive — equal heads pair',
    external: hello(PINNED_CONTRACT_VERSION, SCHEMA_HEADS.appMinimum),
    app: appHello(PINNED_CONTRACT_VERSION, SCHEMA_HEADS.current, SCHEMA_HEADS.appMinimum),
    expected: { ok: true },
  },
  {
    id: 'schema-ahead-of-app-major-matches',
    rule: 'external head > the app head is allowed when contract MAJOR matches (dumb-broker ops are schema-tolerant)',
    external: hello(CONTRACT_VERSIONS.major1Mid, SCHEMA_HEADS.aheadOfApp),
    app: appHello(CONTRACT_VERSIONS.major1Low, SCHEMA_HEADS.current, SCHEMA_HEADS.appMinimum),
    expected: { ok: true },
  },
  {
    id: 'schema-ahead-of-app-major-differs',
    rule: 'a newer external head does NOT rescue a MAJOR mismatch — the contract check runs first',
    external: hello(CONTRACT_VERSIONS.major2, SCHEMA_HEADS.aheadOfApp),
    app: appHello(CONTRACT_VERSIONS.major1High, SCHEMA_HEADS.current, SCHEMA_HEADS.appMinimum),
    expected: { ok: false, reason: 'contract_major_mismatch', hint: 'update_studio' },
  },
]);

/** The broker op shapes, one of each kind the wire carries. */
export const BROKER_FIXTURES = Object.freeze({
  grant: {
    token: 'grant-abc',
    issuedAt: 1_700_000_000_000,
    expiresAt: 1_700_000_060_000,
    mode: 'readwrite',
    tables: ['studio_artifacts', 'studio_runs'],
    schemaHead: SCHEMA_HEADS.current,
  } as BrokerGrant,
  /** No `expiresAt`: a grant that lives until it is revoked, which is the scoping-only arm. */
  readOnlyGrant: {
    token: 't',
    issuedAt: 0,
    mode: 'read',
    tables: ['studio_artifacts'],
    schemaHead: SCHEMA_HEADS.current,
  } as BrokerGrant,
  /** Expires at 10 on the wire's own clock, so a caller can pin the boundary from both sides. */
  expiredGrant: {
    token: 't',
    issuedAt: 0,
    expiresAt: 10,
    mode: 'readwrite',
    tables: ['studio_runs'],
    schemaHead: SCHEMA_HEADS.current,
  } as BrokerGrant,
  read: {
    grant: 'grant-abc',
    kind: 'read',
    table: 'studio_runs',
    where: { run_id: 'run-1' },
    limit: 100,
  } as BrokerReadOp,
  write: {
    grant: 'grant-abc',
    kind: 'insert',
    table: 'studio_run_events',
    row: { run_id: 'run-1', seq: 4, payload: null },
  } as BrokerWriteOp,
  revocation: {
    token: 'grant-abc',
    revokedAt: 1_700_000_120_000,
    reason: 'unpaired',
  } as BrokerRevocation,
  refusal: {
    ok: false,
    reason: 'table_not_granted',
    table: 'studio_audit',
  } as BrokerRefusal,
});

/** The escalation descriptors: the request, the served answer, and a typed decline. */
export const ESCALATION_FIXTURES = Object.freeze({
  request: {
    capability: STUDIO_FETCH_CAPABILITY,
    url: 'https://example.com/walled',
  } as EscalationRequest,
  served: {
    ok: true,
    url: 'https://example.com/walled',
    html: '<html></html>',
    session_id: 'sess-1',
  } as EscalationServed,
  decline: {
    ok: false,
    error_reason: 'capture_refused',
    error: 'The live session page is a login/credential context.',
    hint: 'Do not retry; hand the login off to the human.',
  } as EscalationDecline,
});

/** The session-target descriptors. `input` is deliberately the narrowest real one — a bare url. */
export const SESSION_TARGET_FIXTURES = Object.freeze({
  request: {
    op: 'fetch',
    session_id: 'sess-1',
    input: { url: 'https://example.com' },
  } as SessionTargetRequest<{ url: string }>,
  okResult: { ok: true, data: { url: 'https://example.com' } } as {
    ok: true;
    data: { url: string };
  },
  refusal: {
    ok: false,
    error: 'no_such_session',
    error_reason: 'No live studio session with id sess-9.',
    stage: 'fetch',
    hint: 'Call studio_list for live ids.',
  } as SessionTargetRefusal,
});
