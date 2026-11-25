import { describe, expect, it } from 'vitest';
import { createPinnedLookup, type ValidatedAddress } from '../../src/fetch/pinned-dispatcher.js';

/**
 * The lookup hook is tested directly rather than through a socket: it is the whole security
 * boundary, it is pure, and testing it here means the rebinding case can be expressed exactly —
 * "the second resolution returns something different" — which is impossible to stage reliably
 * against a real resolver.
 */

/**
 * Promisify one call to the lookup hook.
 *
 * The hook is callback-shaped with two arities — `(err, address, family)` normally and
 * `(err, addresses[])` under `all: true` — so both are captured and asserted on per test rather
 * than normalised away here, since picking the wrong arity is itself a way the pin could break.
 */
function callLookup(
  fn: ReturnType<typeof createPinnedLookup>,
  host: string,
  options: { family?: number; all?: boolean } = {},
): Promise<{ err: NodeJS.ErrnoException | null; address: unknown; family?: number }> {
  return new Promise((resolve) => {
    fn(host, options, (err, address, family) => resolve({ err, address, family }));
  });
}

const VALIDATED: ValidatedAddress[] = [{ address: '93.184.216.34', family: 4 }];

describe('createPinnedLookup (DNS-rebinding pin, issue #207)', () => {
  it('returns the validated address instead of re-resolving — the rebinding case', async () => {
    // The attacker's resolver would now answer with the metadata IP. The pin must never ask it.
    const fn = createPinnedLookup('rebind.evil.example', VALIDATED);
    const r = await callLookup(fn, 'rebind.evil.example');
    expect(r.err).toBeNull();
    expect(r.address).toBe('93.184.216.34');
    expect(r.family).toBe(4);
  });

  it('returns the array shape when the socket asks for all: true', async () => {
    const fn = createPinnedLookup('example.com', VALIDATED);
    const r = await callLookup(fn, 'example.com', { all: true });
    expect(r.err).toBeNull();
    expect(r.address).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  it('does NOT pin or resolve a different hostname — it fails closed', async () => {
    // Handing host B the addresses validated for host A would be a worse bug than the one we are
    // fixing, and resolving B for real would reopen the rebinding window, so this is the
    // must-not-do control.
    const fn = createPinnedLookup('example.com', VALIDATED);
    const r = await callLookup(fn, 'other.example');
    expect((r.err as NodeJS.ErrnoException)?.code).toBe('ENOTFOUND');
  });

  it('fails closed when the validated set is empty rather than resolving for real', async () => {
    const fn = createPinnedLookup('example.com', []);
    const r = await callLookup(fn, 'example.com');
    expect((r.err as NodeJS.ErrnoException)?.code).toBe('ENOTFOUND');
  });

  it('honours an explicit family request', async () => {
    const both: ValidatedAddress[] = [
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
    ];
    const fn = createPinnedLookup('example.com', both);
    const v6 = await callLookup(fn, 'example.com', { family: 6 });
    expect(v6.address).toBe('2606:2800:220:1:248:1893:25c8:1946');
    const v4 = await callLookup(fn, 'example.com', { family: 4 });
    expect(v4.address).toBe('93.184.216.34');
  });

  it('fails the lookup when no validated address matches the requested family', async () => {
    // Widening to a family the caller excluded would be silently ignoring the request.
    const fn = createPinnedLookup('example.com', VALIDATED);
    const r = await callLookup(fn, 'example.com', { family: 6 });
    expect(r.err).toBeTruthy();
    expect(r.err?.code).toBe('ENOTFOUND');
  });

  it('passes every validated address through when the socket wants all of them', async () => {
    const many: ValidatedAddress[] = [
      { address: '93.184.216.34', family: 4 },
      { address: '93.184.216.35', family: 4 },
    ];
    const fn = createPinnedLookup('example.com', many);
    const r = await callLookup(fn, 'example.com', { all: true });
    expect(r.address).toEqual(many);
  });
});
