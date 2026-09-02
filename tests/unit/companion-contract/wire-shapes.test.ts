import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  ESCALATION_DECLINE_REASONS,
  ESCALATION_ROUTE,
  STUDIO_FETCH_CAPABILITY,
  isEscalationDecline,
  isEscalationServed,
} from '../../../src/companion-contract/escalation.js';
import {
  SESSION_TARGET_OPS,
  SESSION_TARGET_REFUSAL_REASONS,
  SESSION_TARGET_ROUTE,
  isSessionTargetRefusal,
  isSessionTargeted,
} from '../../../src/companion-contract/session-target.js';
import {
  BROKER_TABLES,
  BROKER_REFUSAL_REASONS,
  BROKER_REVOCATION_REASONS,
  BROKER_WRITE_KINDS,
  isBrokerRefusal,
  grantCovers,
} from '../../../src/companion-contract/broker.js';
import type {
  EscalationRequest,
  EscalationResponse,
} from '../../../src/companion-contract/escalation.js';
import type {
  SessionTargetRequest,
  SessionTargetResult,
} from '../../../src/companion-contract/session-target.js';
import type {
  BrokerGrant,
  BrokerReadOp,
  BrokerWriteOp,
  BrokerRevocation,
  BrokerResult,
} from '../../../src/companion-contract/broker.js';

const repoRoot = process.cwd();

function sourceOf(...segments: string[]): string {
  return readFileSync(join(repoRoot, ...segments), 'utf8');
}

/** Every `error_reason: '<literal>'` a producer file emits — the codes that actually reach the wire. */
function literalsOf(source: string, key: string): string[] {
  return [...source.matchAll(new RegExp(`\\b${key}:\\s*'([a-z0-9_]+)'`, 'g'))]
    .map((m) => m[1]!)
    .sort();
}

/**
 * THE DRIFT CHECK for the three companion wires.
 *
 * Same bargain `contracts/studio-mcp/tests/schema-drift.test.ts` strikes: the contract states shapes the
 * implementation also states, so a copy that can silently diverge is worse than no contract. Each block
 * below therefore reads the WORKING TREE of the producer it claims to describe — the escalation
 * bridge, the session-target forwarding client, the migration set — rather than only asserting
 * against itself. A new decline code, a renamed refusal or a seventh shared table reds HERE, at
 * contract-authoring cost, instead of becoming a wire arm nobody declared.
 *
 * The two cross-checks against the domain-side producers went with the domain layer: the fetch
 * capability name and the unadvertised-capability constant were read out of `src/studio/` and
 * `contracts/studio-mcp/`, and after the extraction the contract is the sole owner of both. The
 * companion repo asserts its own side against this contract, which is what makes the name shared
 * rather than duplicated.
 */
describe('escalation wire', () => {
  it('owns the fetch-capability name every side of the wire uses', () => {
    expect(STUDIO_FETCH_CAPABILITY).toBe('studio_fetch');
  });

  it('keeps exactly one literal of the capability name in src/ — the contract\'s', () => {
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(join(repoRoot, dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(rel);
        else if (entry.name.endsWith('.ts') && /=\s*'studio_fetch'/.test(sourceOf(rel))) hits.push(rel);
      }
    };
    walk('src');
    expect(hits).toEqual(['src/companion-contract/escalation.ts']);
  });

  it('owns the route the transport POSTs to, with no second literal in src/', () => {
    // The address is wire, not implementation: two sides that disagree about it produce a 404 rather than
    // a typed decline, so the same one-literal rule the capability name lives under applies to it.
    expect(ESCALATION_ROUTE).toBe('/companion/escalate');
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(join(repoRoot, dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(rel);
        else if (entry.name.endsWith('.ts') && sourceOf(rel).includes(`'${ESCALATION_ROUTE}'`)) hits.push(rel);
      }
    };
    walk('src');
    expect(hits).toEqual(['src/companion-contract/escalation.ts']);
  });

  it('declares a CLOSED decline enum that covers every code the escalation seam emits', () => {
    // The seam that produced these codes is the companion's fetch handler now; what core keeps is
    // the bridge that READS them, so the bridge is the arm's producer: every decline literal it
    // reaches for — including the one it mints itself when the transport dies before an answer —
    // has to be a member, or core would branch on a code the wire does not declare.
    const bridge = sourceOf('src', 'fetch', 'companion-bridge.ts');
    const emitted = [...bridge.matchAll(/reason:\s*(?:[^'"\n]*?)'([a-z_]+)'/g)].map((m) => m[1]);
    expect(emitted.length).toBeGreaterThan(0);
    for (const code of emitted) expect(ESCALATION_DECLINE_REASONS).toContain(code);
  });

  it('pins the decline enum so widening it is a deliberate edit', () => {
    expect([...ESCALATION_DECLINE_REASONS]).toEqual([
      'blocked_by_challenge',
      'capture_refused',
      'companion_unavailable',
      'invalid_url',
      'navigation_blocked',
      'navigation_failed',
      'not_holder',
      'studio_no_drive',
      'transport_error',
    ]);
    expect(Object.isFrozen(ESCALATION_DECLINE_REASONS)).toBe(true);
  });

  it('round-trips a served response as JSON with a stable shape', () => {
    const request: EscalationRequest = { capability: STUDIO_FETCH_CAPABILITY, url: 'https://example.com/walled' };
    const served: EscalationResponse = {
      ok: true,
      url: 'https://example.com/walled',
      html: '<html></html>',
      session_id: 'sess-1',
    };
    expect(JSON.parse(JSON.stringify(request))).toEqual({
      capability: 'studio_fetch',
      url: 'https://example.com/walled',
    });
    expect(JSON.parse(JSON.stringify(served))).toEqual({
      ok: true,
      url: 'https://example.com/walled',
      html: '<html></html>',
      session_id: 'sess-1',
    });
    expect(isEscalationServed(served)).toBe(true);
    expect(isEscalationDecline(served)).toBe(false);
  });

  it('round-trips a decline as a discriminated union arm', () => {
    const declined: EscalationResponse = {
      ok: false,
      error_reason: 'capture_refused',
      error: 'The live session page is a login/credential context.',
      hint: 'Do not retry; hand the login off to the human.',
    };
    expect(JSON.parse(JSON.stringify(declined))).toEqual({
      ok: false,
      error_reason: 'capture_refused',
      error: 'The live session page is a login/credential context.',
      hint: 'Do not retry; hand the login off to the human.',
    });
    expect(isEscalationDecline(declined)).toBe(true);
    expect(isEscalationServed(declined)).toBe(false);
  });

  it('rejects a foreign reason at the guard, not just at the type', () => {
    expect(isEscalationDecline({ ok: false, error_reason: 'made_up', error: 'x' })).toBe(false);
    expect(isEscalationDecline(null)).toBe(false);
  });
});

describe('session-target wire', () => {
  it('declares exactly the three navigation-class ops the composition implements', () => {
    expect([...SESSION_TARGET_OPS]).toEqual(['crawl', 'extract', 'fetch']);
    const source = sourceOf('src', 'tools', 'session-target.ts');
    for (const op of SESSION_TARGET_OPS) {
      expect(source, `runSession${op} must exist`).toMatch(
        new RegExp(`runSession${op[0]!.toUpperCase()}${op.slice(1)}`),
      );
    }
  });

  it('owns the route both sides address, so a disagreement cannot become a silent 404', () => {
    expect(SESSION_TARGET_ROUTE).toBe('/companion/session');
    // The client must ADDRESS the constant, not a copy of its value: a literal path on either side is
    // exactly the drift this module exists to prevent.
    expect(sourceOf('src', 'tools', 'session-target.ts')).toContain('SESSION_TARGET_ROUTE');
  });

  it('declares a CLOSED refusal enum that covers every code the composition emits', () => {
    // The forwarding client is now the only producer in this repo: the host-side composition left
    // with the domain layer, and the codes it emitted are the ones this enum publishes for it.
    const emitted = [
      ...literalsOf(sourceOf('src', 'tools', 'session-target.ts'), 'error'),
    ];
    expect(emitted.length).toBeGreaterThan(0);
    for (const code of emitted) expect(SESSION_TARGET_REFUSAL_REASONS).toContain(code);
  });

  it('pins the refusal enum', () => {
    expect([...SESSION_TARGET_REFUSAL_REASONS]).toEqual([
      'aborted_reclaimed',
      'capture_refused',
      'companion_unavailable',
      'navigation_blocked',
      'navigation_failed',
      'no_such_session',
      'not_holder',
    ]);
    expect(Object.isFrozen(SESSION_TARGET_REFUSAL_REASONS)).toBe(true);
  });

  it('keeps the producer orientation the composition already publishes (error = code, error_reason = prose)', () => {
    const refusal: SessionTargetResult<never> = {
      ok: false,
      error: 'no_such_session',
      error_reason: 'No live studio session with id sess-9.',
      stage: 'fetch',
      hint: 'Call studio_list for live ids.',
    };
    expect(JSON.parse(JSON.stringify(refusal))).toEqual({
      ok: false,
      error: 'no_such_session',
      error_reason: 'No live studio session with id sess-9.',
      stage: 'fetch',
      hint: 'Call studio_list for live ids.',
    });
    expect(isSessionTargetRefusal(refusal)).toBe(true);
  });

  it('round-trips a request and an ok result', () => {
    const request: SessionTargetRequest<{ url: string }> = {
      op: 'fetch',
      session_id: 'sess-1',
      input: { url: 'https://example.com' },
    };
    expect(JSON.parse(JSON.stringify(request))).toEqual({
      op: 'fetch',
      session_id: 'sess-1',
      input: { url: 'https://example.com' },
    });
    const ok: SessionTargetResult<{ url: string }> = { ok: true, data: { url: 'https://example.com' } };
    expect(isSessionTargetRefusal(ok)).toBe(false);
  });

  it('routes on a non-empty session_id exactly as the composition does today', () => {
    expect(isSessionTargeted({ session_id: 'sess-1' })).toBe(true);
    expect(isSessionTargeted({ session_id: '   ' })).toBe(false);
    expect(isSessionTargeted({ session_id: '' })).toBe(false);
    expect(isSessionTargeted({})).toBe(false);
    expect(isSessionTargeted({ session_id: 7 })).toBe(false);
  });
});

describe('broker wire', () => {
  it('names exactly the shared studio_* tables the migrations create', () => {
    const dir = join(repoRoot, 'src', 'cache', 'migrations');
    const declared = new Set<string>();
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql'))) {
      const sql = readFileSync(join(dir, file), 'utf8');
      for (const m of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(studio_[a-z_]+)"?/gi)) {
        declared.add(m[1]!.toLowerCase());
      }
    }
    expect([...BROKER_TABLES].sort()).toEqual([...declared].sort());
    expect(Object.isFrozen(BROKER_TABLES)).toBe(true);
  });

  it('is a DUMB broker: the op shapes name tables, never domain methods', () => {
    const source = sourceOf('src', 'companion-contract', 'broker.ts');
    for (const domainMethod of ['persistMark', 'synthesizeSession', 'runCreate', 'findSimilar', 'listArtifacts']) {
      expect(source, `broker wire must not carry the domain method ${domainMethod}`).not.toContain(domainMethod);
    }
  });

  it('pins the refusal and revocation enums', () => {
    expect([...BROKER_REFUSAL_REASONS]).toEqual([
      'grant_expired',
      'grant_revoked',
      'no_grant',
      'row_limit_exceeded',
      'table_not_granted',
      'unknown_table',
      'write_not_granted',
    ]);
    expect([...BROKER_REVOCATION_REASONS]).toEqual(['expired', 'schema_skew', 'superseded', 'unpaired']);
    expect([...BROKER_WRITE_KINDS]).toEqual(['delete', 'insert', 'update']);
  });

  it('round-trips a grant, a read op, a write op and a revocation as JSON', () => {
    const grant: BrokerGrant = {
      token: 'grant-abc',
      issuedAt: 1_700_000_000_000,
      expiresAt: 1_700_000_060_000,
      mode: 'readwrite',
      tables: ['studio_artifacts', 'studio_runs'],
      schemaHead: 18,
    };
    const read: BrokerReadOp = {
      grant: 'grant-abc',
      kind: 'read',
      table: 'studio_runs',
      where: { run_id: 'run-1' },
      limit: 100,
    };
    const write: BrokerWriteOp = {
      grant: 'grant-abc',
      kind: 'insert',
      table: 'studio_run_events',
      row: { run_id: 'run-1', seq: 4, payload: null },
    };
    const revocation: BrokerRevocation = {
      token: 'grant-abc',
      revokedAt: 1_700_000_120_000,
      reason: 'unpaired',
    };
    for (const value of [grant, read, write, revocation]) {
      expect(JSON.parse(JSON.stringify(value))).toEqual(value);
    }
  });

  it('refuses with a discriminated arm the guard recognises', () => {
    const refusal: BrokerResult<never> = {
      ok: false,
      reason: 'table_not_granted',
      table: 'studio_audit',
    };
    expect(isBrokerRefusal(refusal)).toBe(true);
    expect(isBrokerRefusal({ ok: true, rows: [] })).toBe(false);
    expect(isBrokerRefusal({ ok: false, reason: 'made_up' })).toBe(false);
  });

  it('scopes a grant to its tables and its mode', () => {
    const readOnly: BrokerGrant = {
      token: 't',
      issuedAt: 0,
      mode: 'read',
      tables: ['studio_artifacts'],
      schemaHead: 18,
    };
    expect(grantCovers(readOnly, 'studio_artifacts', 'read')).toBe(true);
    expect(grantCovers(readOnly, 'studio_artifacts', 'write')).toBe(false);
    expect(grantCovers(readOnly, 'studio_runs', 'read')).toBe(false);
    const rw: BrokerGrant = { ...readOnly, mode: 'readwrite', tables: ['studio_runs'] };
    expect(grantCovers(rw, 'studio_runs', 'write')).toBe(true);
  });

  it('treats an expired grant as not covering anything, at the shared clock the wire carries', () => {
    const expired: BrokerGrant = {
      token: 't',
      issuedAt: 0,
      expiresAt: 10,
      mode: 'readwrite',
      tables: ['studio_runs'],
      schemaHead: 18,
    };
    expect(grantCovers(expired, 'studio_runs', 'write', 9)).toBe(true);
    expect(grantCovers(expired, 'studio_runs', 'write', 10)).toBe(false);
    expect(grantCovers(expired, 'studio_runs', 'write', 11)).toBe(false);
  });
});
