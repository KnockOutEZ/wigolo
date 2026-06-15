import { describe, it, expect } from 'vitest';
import { SessionRegistry } from '../../../src/studio/registry.js';

describe('studio/SessionRegistry', () => {
  it('create/get/list round-trips a session', () => {
    const reg = new SessionRegistry();
    const s = reg.create({ endpoint: 'http://127.0.0.1:7777' });
    expect(reg.get(s.id)).toBe(s);
    expect(reg.list()).toContain(s);
    expect(reg.size).toBe(1);
  });

  it('active() returns the sole open session; undefined when none or ambiguous', () => {
    const reg = new SessionRegistry();
    expect(reg.active()).toBeUndefined();
    const s1 = reg.create({ endpoint: 'e1' });
    expect(reg.active()).toBe(s1);
    reg.create({ endpoint: 'e2' });
    expect(reg.active()).toBeUndefined(); // two open → caller must pass session_id
  });

  it('close removes a session and marks it closed; closeAll empties and closes each', () => {
    const reg = new SessionRegistry();
    const s1 = reg.create({ endpoint: 'e1' });
    const s2 = reg.create({ endpoint: 'e2' });
    reg.close(s1.id);
    expect(reg.get(s1.id)).toBeUndefined();
    expect(s1.status).toBe('closed');
    reg.closeAll();
    expect(reg.size).toBe(0);
    expect(s2.status).toBe('closed');
  });

  it('sweepIdle evicts only clientless sessions idle past idleMs', () => {
    let t = 0;
    const reg = new SessionRegistry({ idleMs: 1000, now: () => t });
    const idle = reg.create({ endpoint: 'idle' });
    const busy = reg.create({ endpoint: 'busy' });
    busy.attach(); // a client is attached → must not be evicted
    t = 2000; // both are now 2000ms old (> 1000 idleMs)
    const evicted = reg.sweepIdle();
    expect(evicted).toEqual([idle.id]);
    expect(reg.get(idle.id)).toBeUndefined();
    expect(idle.status).toBe('closed');
    expect(reg.get(busy.id)).toBe(busy);
  });

  it('sweepIdle keeps a recently-touched session', () => {
    let t = 0;
    const reg = new SessionRegistry({ idleMs: 1000, now: () => t });
    const s = reg.create({ endpoint: 'e' });
    t = 500;
    s.touch();
    t = 1200; // age 700 < 1000
    expect(reg.sweepIdle()).toEqual([]);
    expect(reg.get(s.id)).toBe(s);
  });
});
