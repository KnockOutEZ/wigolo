import { describe, it, expect } from 'vitest';
import { ControlToken } from '../../../src/studio/control-token.js';

function clock(start = 1000) {
  let t = start;
  return { now: () => t, advance: (d: number) => { t += d; } };
}

describe('ControlToken', () => {
  it('defaults to the human holder at epoch 0', () => {
    const tok = new ControlToken();
    expect(tok.holder).toBe('human');
    expect(tok.epoch).toBe(0);
  });

  it('reclaim() from agent flips to human and bumps the epoch (instant human takeover)', () => {
    const tok = new ControlToken();
    tok.grant('agent');
    expect(tok.holder).toBe('agent');
    expect(tok.epoch).toBe(1);
    tok.reclaim();
    expect(tok.holder).toBe('human');
    expect(tok.epoch).toBe(2);
  });

  it('reclaim() when the human already holds is a no-op (no spurious epoch bump)', () => {
    const tok = new ControlToken();
    tok.reclaim();
    expect(tok.holder).toBe('human');
    expect(tok.epoch).toBe(0);
  });

  it('grant(agent) hands control to the agent and bumps the epoch; granting the current holder is a no-op', () => {
    const tok = new ControlToken();
    tok.grant('agent');
    expect(tok.holder).toBe('agent');
    expect(tok.epoch).toBe(1);
    tok.grant('agent');
    expect(tok.epoch).toBe(1);
  });

  it('release() from agent returns control to the human (epoch bump); from human it is a no-op', () => {
    const tok = new ControlToken();
    tok.grant('agent');
    tok.release();
    expect(tok.holder).toBe('human');
    expect(tok.epoch).toBe(2);
    tok.release();
    expect(tok.epoch).toBe(2);
  });

  it('requestControl(agent) is denied in Phase 1 and changes nothing (agent cannot seize control)', () => {
    const tok = new ControlToken();
    expect(tok.requestControl('agent')).toEqual({ granted: false });
    expect(tok.holder).toBe('human');
    expect(tok.epoch).toBe(0);
  });

  it('canDrive gates on BOTH the current holder and the HOST epoch (a stale client-claimed epoch is rejected)', () => {
    const tok = new ControlToken();
    expect(tok.canDrive('human', 0)).toBe(true); // holder + current host epoch
    expect(tok.canDrive('agent', 0)).toBe(false); // not the holder
    tok.grant('agent'); // host epoch → 1, holder agent
    expect(tok.canDrive('human', 1)).toBe(false); // no longer the holder
    expect(tok.canDrive('agent', 1)).toBe(true); // holder + current host epoch
    expect(tok.canDrive('agent', 0)).toBe(false); // in-flight pre-flip epoch → dropped (host epoch is authoritative)
  });

  it('assertCanDrive returns ok for the holder, else a refusal carrying the current host epoch (Phase-2 primitive)', () => {
    const tok = new ControlToken();
    expect(tok.assertCanDrive('human')).toEqual({ ok: true });
    tok.grant('agent');
    expect(tok.assertCanDrive('human')).toEqual({ ok: false, reason: 'not_holder', currentEpoch: 1 });
  });

  it('onChange fires {holder, epoch} on every flip, never on a no-op', () => {
    const tok = new ControlToken();
    const seen: Array<{ holder: string; epoch: number }> = [];
    tok.onChange((s) => seen.push(s));
    tok.grant('agent'); // flip
    tok.grant('agent'); // no-op
    tok.reclaim(); // flip
    tok.reclaim(); // no-op
    expect(seen).toEqual([
      { holder: 'agent', epoch: 1 },
      { holder: 'human', epoch: 2 },
    ]);
  });

  it('advances `since` via the injected clock on a flip, leaving it untouched on a no-op', () => {
    const c = clock(1000);
    const tok = new ControlToken({ now: c.now });
    expect(tok.snapshot().since).toBe(1000);
    c.advance(500);
    tok.grant('agent');
    expect(tok.snapshot().since).toBe(1500);
    c.advance(500);
    tok.grant('agent'); // no-op
    expect(tok.snapshot().since).toBe(1500);
  });
});
