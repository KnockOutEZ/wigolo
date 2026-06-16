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
});
