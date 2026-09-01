import { describe, it, expect } from 'vitest';
import { ControlToken } from '../../../src/studio/control-token.js';
import { SessionController } from '../../../src/studio/session-control.js';
import { HeldSnapshot, HUMAN_EDIT_KINDS } from '../../../src/studio/perception/held-snapshot.js';
import type { AgentInputEvent } from '../../../src/studio/input-events.js';

function makeFakeInput() {
  const calls = { key: 0, neutralize: 0, agentMouseAt: 0 };
  return {
    input: {
      key: async () => { calls.key++; },
      neutralizeHeld: async () => { calls.neutralize++; },
      agentMouseAt: async () => { calls.agentMouseAt++; },
      viewportCenter: () => ({ x: 50, y: 60 }),
    },
    calls,
  };
}

describe('SessionController', () => {
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

  it('announce() forwards an arbitrary UI event through the same broadcast sink the flips use', () => {
    const token = new ControlToken();
    const sent: Array<Record<string, unknown>> = [];
    const ctl = new SessionController(token, makeFakeInput().input, (m) => sent.push(m));
    ctl.announce({ t: 'act', action: 'click', narration: 'opening FAQ' });
    expect(sent).toContainEqual({ t: 'act', action: 'click', narration: 'opening FAQ' });
    ctl.announce({ t: 'point', center: { x: 12, y: 34 }, caption: 'opening FAQ' });
    expect(sent).toContainEqual({ t: 'point', center: { x: 12, y: 34 }, caption: 'opening FAQ' });
  });

});

describe('SessionController — agent input dispatch (2J.2, the abort layer)', () => {
  it('dispatchAgentUnit fires the whole unit when the agent holds at the gate epoch', async () => {
    const token = new ControlToken();
    token.grant('agent'); // epoch 1, agent holds
    const f = makeFakeInput();
    const ctl = new SessionController(token, f.input, () => {});
    const landed = await ctl.dispatchAgentUnit(1, [
      { kind: 'mouse', type: 'mousePressed', x: 10, y: 20, button: 'left', buttons: 1, clickCount: 1 },
      { kind: 'mouse', type: 'mouseReleased', x: 10, y: 20, button: 'left', buttons: 0, clickCount: 1 },
    ]);
    expect(landed).toBe(true);
    expect(f.calls.agentMouseAt).toBe(2); // both sub-events of the click dispatched
  });

  it('HARD STOP (epoch fence): a unit dispatched with a STALE epoch after a reclaim is dropped — NOT ONE sub-event is sent', async () => {
    // This is the strong-version safety boundary: even if a unit "raced past" a higher
    // re-check, the epoch fence inside dispatch drops it because the reclaim flipped the
    // epoch. We force the stale epoch directly (not via a loop skip).
    const token = new ControlToken();
    token.grant('agent'); // epoch 1 — the gate epoch the unit is stamped with
    const f = makeFakeInput();
    const ctl = new SessionController(token, f.input, () => {});
    token.reclaim(); // human takeover → epoch 2
    const landed = await ctl.dispatchAgentUnit(1, [
      { kind: 'key', type: 'keyDown', key: 'a', code: 'KeyA' },
      { kind: 'key', type: 'char', key: 'a', text: 'a' },
      { kind: 'key', type: 'keyUp', key: 'a', code: 'KeyA' },
    ]);
    expect(landed).toBe(false);
    expect(f.calls.key).toBe(0); // the fence dropped the ENTIRE unit, not just "the next one"
  });

  it('drops an agent unit while the human holds (party must match too — only agent events are epoch-gated)', async () => {
    const token = new ControlToken(); // human holds, epoch 0
    const f = makeFakeInput();
    const ctl = new SessionController(token, f.input, () => {});
    const landed = await ctl.dispatchAgentUnit(0, [{ kind: 'key', type: 'keyDown', key: 'a', code: 'KeyA' }]);
    expect(landed).toBe(false);
    expect(f.calls.key).toBe(0);
  });

  it('fires a keystroke unit through the same key channel the human uses (single channel)', async () => {
    const token = new ControlToken();
    token.grant('agent');
    const f = makeFakeInput();
    const ctl = new SessionController(token, f.input, () => {});
    const landed = await ctl.dispatchAgentUnit(1, [
      { kind: 'key', type: 'keyDown', key: 'a', code: 'KeyA' },
      { kind: 'key', type: 'char', key: 'a', text: 'a' },
      { kind: 'key', type: 'keyUp', key: 'a', code: 'KeyA' },
    ]);
    expect(landed).toBe(true);
    expect(f.calls.key).toBe(3);
  });

  it('viewportCenter delegates to the input channel (agent scroll aim)', () => {
    const token = new ControlToken();
    const f = makeFakeInput();
    const ctl = new SessionController(token, f.input, () => {});
    expect(ctl.viewportCenter()).toEqual({ x: 50, y: 60 });
  });
});

describe('SessionController — human vs agent input attribution (§7 row 1)', () => {
  const makeHeld = () => {
    const held = new HeldSnapshot();
    held.hold({
      id: 's1', elements: [{ ref: 'e1', role: 'textbox', name: 'Search' }], tokenCount: 1,
      overBudget: false, domTruncated: false, refMap: new Map(), groupByRef: new Map(), domParent: new Map(),
    });
    return held;
  };

  it('a human edit on the session invalidates the held snapshot', () => {
    const held = makeHeld();
    const ctl = new SessionController(new ControlToken(), makeFakeInput().input, () => {}, held);
    expect(ctl.humanInput('key')).toBe(true);
    expect(held.read().state).toBe('invalidated');
  });

  it('EVERY §5 human shape reaches the holder through this seam', () => {
    for (const kind of HUMAN_EDIT_KINDS) {
      const held = makeHeld();
      const ctl = new SessionController(new ControlToken(), makeFakeInput().input, () => {}, held);
      expect(ctl.humanInput(kind), kind).toBe(true);
    }
  });

  it('an unrecognised wire shape is ignored rather than guessed at', () => {
    const held = makeHeld();
    const ctl = new SessionController(new ControlToken(), makeFakeInput().input, () => {}, held);
    for (const junk of ['scroll', 'mouse_move', '', 42, null, { kind: 'key' }]) {
      expect(ctl.humanInput(junk)).toBe(false);
    }
    expect(held.read().state).toBe('live');
  });

  it('the agent driving its OWN input units never trips the trigger', async () => {
    // The attribution IS the two methods: agent input is only deliverable through
    // dispatchAgentUnit, which has no path to the holder. Every agent unit shape — the click
    // pair, a modifier-wrapped keystroke run, a wheel — must leave the snapshot live.
    // MUT: call `held.humanEdit('key')` from dispatchAgentUnit → every arm below goes RED.
    const held = makeHeld();
    const token = new ControlToken();
    const ctl = new SessionController(token, makeFakeInput().input, () => {}, held);
    token.grant('agent');
    const epoch = token.epoch;
    const units: AgentInputEvent[][] = [
      [{ kind: 'mouse', type: 'mousePressed', x: 1, y: 2, button: 'left', clickCount: 1 },
       { kind: 'mouse', type: 'mouseReleased', x: 1, y: 2, button: 'left', clickCount: 1 }],
      [{ kind: 'key', type: 'keyDown', key: 'h', code: 'KeyH' }, { kind: 'key', type: 'char', key: 'h', text: 'h' }, { kind: 'key', type: 'keyUp', key: 'h', code: 'KeyH' }],
      [{ kind: 'mouse', type: 'mouseWheel', x: 1, y: 2, deltaX: 0, deltaY: 120 }],
    ];
    for (const unit of units) {
      expect(await ctl.dispatchAgentUnit(epoch, unit)).toBe(true);
      expect(held.read().state, JSON.stringify(unit[0])).toBe('live');
    }
  });

  it('without a holder the seam is inert (a headless host that perceives nothing)', () => {
    const ctl = new SessionController(new ControlToken(), makeFakeInput().input, () => {});
    expect(ctl.humanInput('key')).toBe(false);
  });
});
