import { describe, it, expect } from 'vitest';
import { ControlToken } from '../../../src/studio/control-token.js';
import { SessionController } from '../../../src/studio/session-control.js';

function makeFakeInput() {
  const calls = { mouse: 0, key: 0, neutralize: 0 };
  return {
    input: {
      mouse: async () => { calls.mouse++; },
      key: async () => { calls.key++; },
      neutralizeHeld: async () => { calls.neutralize++; },
    },
    calls,
  };
}

describe('SessionController', () => {
  it('dispatches input from the current holder at the current epoch', async () => {
    const token = new ControlToken(); // human, epoch 0
    const f = makeFakeInput();
    const ctl = new SessionController(token, f.input, () => {});
    const applied = await ctl.handleInput({ party: 'human', epoch: 0, kind: 'mouse', type: 'mousePressed', nx: 0.5, ny: 0.5, button: 'left' });
    expect(applied).toBe(true);
    expect(f.calls.mouse).toBe(1);
  });

  it('drops input with a stale epoch (in-flight across a flip) — host epoch is authoritative', async () => {
    const token = new ControlToken();
    const f = makeFakeInput();
    const ctl = new SessionController(token, f.input, () => {});
    token.grant('agent'); // host epoch → 1
    const applied = await ctl.handleInput({ party: 'human', epoch: 0, kind: 'mouse', type: 'mouseMoved', nx: 0.1, ny: 0.1 });
    expect(applied).toBe(false);
    expect(f.calls.mouse).toBe(0);
  });

  it('drops input from a non-holder party', async () => {
    const token = new ControlToken(); // human holds
    const f = makeFakeInput();
    const ctl = new SessionController(token, f.input, () => {});
    const applied = await ctl.handleInput({ party: 'agent', epoch: 0, kind: 'key', type: 'keyDown', key: 'a', code: 'KeyA' });
    expect(applied).toBe(false);
    expect(f.calls.key).toBe(0);
  });

  it('on a control flip: neutralizes the outgoing holder’s held input and broadcasts the new {holder, epoch}', async () => {
    const token = new ControlToken();
    const f = makeFakeInput();
    const broadcasts: Array<Record<string, unknown>> = [];
    const ctl = new SessionController(token, f.input, (m) => broadcasts.push(m));
    ctl.handleControl({ op: 'grant', to: 'agent' });
    expect(f.calls.neutralize).toBe(1);
    expect(broadcasts).toEqual([{ t: 'control', holder: 'agent', epoch: 1 }]);
    ctl.handleControl({ op: 'reclaim' }); // human takeover
    expect(f.calls.neutralize).toBe(2);
    expect(broadcasts[1]).toEqual({ t: 'control', holder: 'human', epoch: 2 });
  });

  it('enforces token semantics: after grant(agent), agent input lands and human input is dropped', async () => {
    const token = new ControlToken();
    const f = makeFakeInput();
    const ctl = new SessionController(token, f.input, () => {});
    ctl.handleControl({ op: 'grant', to: 'agent' }); // epoch 1, agent holds
    expect(await ctl.handleInput({ party: 'agent', epoch: 1, kind: 'mouse', type: 'mouseMoved', nx: 0, ny: 0 })).toBe(true);
    expect(await ctl.handleInput({ party: 'human', epoch: 1, kind: 'mouse', type: 'mouseMoved', nx: 0, ny: 0 })).toBe(false);
  });

  it('handleWireInput host-stamps party=human — a WS client cannot claim to be the agent (landmine #1)', async () => {
    const token = new ControlToken();
    const f = makeFakeInput();
    const ctl = new SessionController(token, f.input, () => {});
    // Client lies (party:'agent'); it is treated as human → human holds → dispatched.
    expect(await ctl.handleWireInput({ party: 'agent', epoch: 0, kind: 'mouse', type: 'mouseMoved', nx: 0.5, ny: 0.5 })).toBe(true);
    expect(f.calls.mouse).toBe(1);
    // After granting the agent, that same WS client (forced to 'human') is gated out.
    ctl.handleControl({ op: 'grant', to: 'agent' });
    expect(await ctl.handleWireInput({ party: 'agent', epoch: 1, kind: 'mouse', type: 'mouseMoved', nx: 0.5, ny: 0.5 })).toBe(false);
  });

  it('handleWireControl applies a reclaim parsed from the wire', () => {
    const token = new ControlToken();
    const f = makeFakeInput();
    const ctl = new SessionController(token, f.input, () => {});
    token.grant('agent'); // epoch 1
    ctl.handleWireControl({ op: 'reclaim' });
    expect(token.holder).toBe('human');
    expect(token.epoch).toBe(2);
  });

  it('handleWireControl ignores an unknown op and parses grant-to-human', () => {
    const token = new ControlToken();
    const ctl = new SessionController(token, makeFakeInput().input, () => {});
    ctl.handleWireControl({ op: 'bogus' }); // ignored — no change
    expect(token.epoch).toBe(0);
    token.grant('agent'); // epoch 1
    ctl.handleWireControl({ op: 'grant', to: 'human' }); // epoch 2, human
    expect(token.holder).toBe('human');
    expect(token.epoch).toBe(2);
  });

  it('handleWireInput drops input with a non-numeric epoch (coerced to a value that never matches)', async () => {
    const token = new ControlToken();
    const f = makeFakeInput();
    const ctl = new SessionController(token, f.input, () => {});
    expect(await ctl.handleWireInput({ kind: 'mouse', epoch: 'lol', type: 'mouseMoved', nx: 0.5, ny: 0.5 })).toBe(false);
    expect(f.calls.mouse).toBe(0);
  });
});
