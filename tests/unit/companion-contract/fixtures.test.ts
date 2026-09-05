import { describe, expect, it } from 'vitest';

import {
  BROKER_REFUSAL_REASONS,
  BROKER_REVOCATION_REASONS,
  BROKER_TABLES,
  BROKER_WRITE_KINDS,
  ESCALATION_DECLINE_REASONS,
  SESSION_TARGET_OPS,
  SESSION_TARGET_REFUSAL_REASONS,
  STUDIO_FETCH_CAPABILITY,
  isBrokerRefusal,
  isEscalationDecline,
  isEscalationServed,
  isSessionTargetRefusal,
} from '../../../src/companion-contract/index.js';
import {
  BROKER_FIXTURES,
  ESCALATION_FIXTURES,
  HANDSHAKE_CASES,
  SESSION_TARGET_FIXTURES,
} from '../../../src/companion-contract/fixtures.js';

/**
 * The fixture set is the mechanism two repositories agree through, so it needs its own guard: a
 * descriptor that the contract's own predicates REJECT would hand the app a shape core never accepts,
 * and it would do it silently — the app's test would go green against a fixture core's wire refuses.
 *
 * This file is therefore not "tests for data". It is the check that every published descriptor is a
 * legal member of the enum or union it claims, run against the contract's own guards rather than
 * against a re-statement of them.
 */
describe('published companion-contract fixtures', () => {
  it('publishes escalation descriptors the contract guards accept', () => {
    expect(ESCALATION_FIXTURES.request.capability).toBe(STUDIO_FETCH_CAPABILITY);
    expect(isEscalationServed(ESCALATION_FIXTURES.served)).toBe(true);
    expect(isEscalationDecline(ESCALATION_FIXTURES.served)).toBe(false);
    expect(isEscalationDecline(ESCALATION_FIXTURES.decline)).toBe(true);
    expect(ESCALATION_DECLINE_REASONS).toContain(ESCALATION_FIXTURES.decline.error_reason);
  });

  it('publishes session-target descriptors inside the declared op and refusal enums', () => {
    expect(SESSION_TARGET_OPS).toContain(SESSION_TARGET_FIXTURES.request.op);
    expect(SESSION_TARGET_OPS).toContain(SESSION_TARGET_FIXTURES.refusal.stage);
    expect(SESSION_TARGET_REFUSAL_REASONS).toContain(SESSION_TARGET_FIXTURES.refusal.error);
    expect(isSessionTargetRefusal(SESSION_TARGET_FIXTURES.refusal)).toBe(true);
    expect(isSessionTargetRefusal(SESSION_TARGET_FIXTURES.okResult)).toBe(false);
  });

  it('publishes broker ops that name only granted-able tables and declared kinds', () => {
    const grants = [
      BROKER_FIXTURES.grant,
      BROKER_FIXTURES.readOnlyGrant,
      BROKER_FIXTURES.expiredGrant,
    ];
    for (const grant of grants) {
      for (const table of grant.tables) expect(BROKER_TABLES).toContain(table);
    }
    // A fixture op that names a table the wire does not carry would make the app's broker test green
    // against a table core refuses at `grantCovers` — the exact drift the shared set exists to stop.
    expect(BROKER_TABLES).toContain(BROKER_FIXTURES.read.table);
    expect(BROKER_TABLES).toContain(BROKER_FIXTURES.write.table);
    expect(BROKER_TABLES).toContain(BROKER_FIXTURES.refusal.table!);
    expect(BROKER_WRITE_KINDS).toContain(BROKER_FIXTURES.write.kind);
    expect(BROKER_REVOCATION_REASONS).toContain(BROKER_FIXTURES.revocation.reason);
    expect(BROKER_REFUSAL_REASONS).toContain(BROKER_FIXTURES.refusal.reason);
    expect(isBrokerRefusal(BROKER_FIXTURES.refusal)).toBe(true);
  });

  it('carries a hand-written verdict on every handshake arm, never one the evaluator computed', () => {
    // An `expected` produced by `evaluateHandshake` would agree with any behaviour it grows, so the
    // arms are only worth iterating if each verdict is a literal an author wrote. Every arm therefore
    // states one of exactly three shapes, and the refusal arms state the hint too.
    for (const arm of HANDSHAKE_CASES) {
      if (arm.expected.ok) {
        expect(Object.keys(arm.expected)).toEqual(['ok']);
        continue;
      }
      expect(['contract_major_mismatch', 'schema_too_old']).toContain(arm.expected.reason);
      expect(['update_wigolo', 'update_studio']).toContain(arm.expected.hint);
    }
    expect(HANDSHAKE_CASES.filter((a) => a.expected.ok).length).toBeGreaterThan(0);
    expect(HANDSHAKE_CASES.filter((a) => !a.expected.ok).length).toBeGreaterThan(0);
  });

  it('gives every arm a unique id and a stated rule, so a cross-repo failure names itself', () => {
    const ids = HANDSHAKE_CASES.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const arm of HANDSHAKE_CASES) expect(arm.rule.length).toBeGreaterThan(10);
  });

  it('is frozen where it is a set, so a consumer cannot mutate the shared pin under the other repo', () => {
    expect(Object.isFrozen(HANDSHAKE_CASES)).toBe(true);
    expect(Object.isFrozen(BROKER_FIXTURES)).toBe(true);
    expect(Object.isFrozen(ESCALATION_FIXTURES)).toBe(true);
    expect(Object.isFrozen(SESSION_TARGET_FIXTURES)).toBe(true);
  });
});
