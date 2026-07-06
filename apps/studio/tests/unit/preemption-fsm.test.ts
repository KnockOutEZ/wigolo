import { describe, it, expect } from 'vitest';
import { ControlToken } from 'wigolo/studio';
import { PreemptionFsm } from '../../src/main/preemption-fsm';

describe('PreemptionFsm — per-tab human⇄agent⇄paused (spec §5)', () => {
  it('a human-held tab starts in human state', () => {
    const fsm = new PreemptionFsm(new ControlToken({ initialHolder: 'human' }));
    expect(fsm.state()).toBe('human');
  });

  it('agentAcquire grants the agent control and returns the epoch to stamp', () => {
    const token = new ControlToken({ initialHolder: 'human' });
    const fsm = new PreemptionFsm(token);
    const epoch = fsm.agentAcquire();
    expect(fsm.state()).toBe('agent');
    expect(epoch).toBe(token.epoch);
    expect(fsm.canAgentStep(epoch)).toBe(true);
  });

  it('native human input while the agent drives preempts instantly → paused, and the in-flight step is fenced', () => {
    const fsm = new PreemptionFsm(new ControlToken({ initialHolder: 'human' }));
    const epoch = fsm.agentAcquire();
    fsm.onHumanInput();
    expect(fsm.state()).toBe('paused');
    // the agent's in-flight unit stamped `epoch`; after preemption its fence must fail
    expect(fsm.canAgentStep(epoch)).toBe(false);
  });

  it('human input when no agent is driving does not spuriously bump the epoch', () => {
    const token = new ControlToken({ initialHolder: 'human' });
    const fsm = new PreemptionFsm(token);
    const e0 = token.epoch;
    fsm.onHumanInput();
    expect(fsm.state()).toBe('human');
    expect(token.epoch).toBe(e0);
  });

  it('agent can re-acquire after a preemption (paused → agent)', () => {
    const fsm = new PreemptionFsm(new ControlToken({ initialHolder: 'human' }));
    fsm.agentAcquire();
    fsm.onHumanInput();
    expect(fsm.state()).toBe('paused');
    const e2 = fsm.agentAcquire();
    expect(fsm.state()).toBe('agent');
    expect(fsm.canAgentStep(e2)).toBe(true);
  });

  it('agentRelease returns control to the human', () => {
    const fsm = new PreemptionFsm(new ControlToken({ initialHolder: 'human' }));
    fsm.agentAcquire();
    fsm.agentRelease();
    expect(fsm.state()).toBe('human');
  });

  it('PROPERTY: no operation sequence ever yields two simultaneous drivers, and a human input after agentAcquire always fences that agent epoch', () => {
    const ops = ['agentAcquire', 'onHumanInput', 'agentRelease'] as const;
    // deterministic pseudo-random walk (no Math.random in this env; index-seeded)
    for (let seed = 0; seed < 200; seed++) {
      const token = new ControlToken({ initialHolder: 'human' });
      const fsm = new PreemptionFsm(token);
      let lastAgentEpoch = -1;
      let humanInputSinceAcquire = false;
      let s = seed;
      for (let step = 0; step < 12; step++) {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        const op = ops[s % ops.length];
        if (op === 'agentAcquire') {
          lastAgentEpoch = fsm.agentAcquire();
          humanInputSinceAcquire = false;
        } else if (op === 'onHumanInput') {
          const wasAgent = fsm.state() === 'agent';
          fsm.onHumanInput();
          if (wasAgent || lastAgentEpoch >= 0) humanInputSinceAcquire = true;
        } else {
          fsm.agentRelease();
        }
        // Invariant 1: single holder — agent and human can never both drive at the current epoch.
        const agentDrives = token.canDrive('agent', token.epoch);
        const humanDrives = token.canDrive('human', token.epoch);
        expect(agentDrives && humanDrives).toBe(false);
        // Invariant 2: once a human input followed an acquire, that agent epoch is fenced forever.
        if (humanInputSinceAcquire && lastAgentEpoch >= 0) {
          expect(fsm.canAgentStep(lastAgentEpoch)).toBe(false);
        }
      }
    }
  });
});
