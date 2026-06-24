import { describe, it, expect, vi } from 'vitest';
import { ApprovalsModel } from './approvals.js';

/**
 * The client holder of the SERVER-authoritative pending-approval set (7d S1). The host owns the truth: a
 * request appears only when an {t:'approval_request'} down-message feeds the model — there is NO optimistic
 * local add, so the human can never be shown an approval the host did not ask for. A request leaves the set
 * when the human answers it (resolve), mirroring the host settling its side of the round-trip.
 */
describe('ApprovalsModel — server-authoritative pending approvals', () => {
  it('is empty until the server feeds a request (no optimistic local add)', () => {
    const m = new ApprovalsModel();
    expect(m.snapshot()).toEqual([]);
  });

  it('adds a server-sent request and exposes it in the snapshot', () => {
    const m = new ApprovalsModel();
    m.add({ id: 1, action: 'click', risk: 'money', target: { url: 'https://shop.test/buy' } });
    expect(m.snapshot()).toEqual([{ id: 1, action: 'click', risk: 'money', target: { url: 'https://shop.test/buy' } }]);
  });

  it('resolves (removes) a request by its exact id, leaving the others', () => {
    const m = new ApprovalsModel();
    m.add({ id: 1, action: 'click', risk: 'money' });
    m.add({ id: 2, action: 'type', risk: 'credential' });
    m.resolve(1);
    expect(m.snapshot().map((r) => r.id)).toEqual([2]);
  });

  it('upserts by id — a re-request of the same id replaces in place, never duplicates', () => {
    const m = new ApprovalsModel();
    m.add({ id: 1, action: 'click', risk: 'money' });
    m.add({ id: 1, action: 'click', risk: 'destructive' });
    expect(m.snapshot()).toEqual([{ id: 1, action: 'click', risk: 'destructive' }]);
  });

  it('notifies subscribers on add and on resolve', () => {
    const m = new ApprovalsModel();
    const cb = vi.fn();
    m.subscribe(cb);
    m.add({ id: 1, action: 'click', risk: 'money' });
    m.resolve(1);
    expect(cb).toHaveBeenCalledTimes(2);
  });
});
