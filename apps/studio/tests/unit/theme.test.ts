// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  currentRegister,
  followSystemRegister,
  installTokens,
  setRegister,
  systemRegister,
} from '../../src/renderer/theme';

/**
 * jsdom parses the stylesheet but does not resolve `var()`, so these tests cover the wiring — one
 * owned style element, the attribute contract, and the system follow. That a switched attribute
 * actually repaints the app is a real-browser claim and is asserted in tests/e2e/register.spec.ts.
 */

/** The one query the studio is allowed to ask: §11 is entered by the system asking for light. */
const LIGHT_QUERY = '(prefers-color-scheme: light)';

/**
 * A `matchMedia` whose media state can be changed, which jsdom's own implementation cannot.
 *
 * It also HONOURS THE QUERY, which is not a detail. The earlier fake ignored its argument and answered
 * every query with the same object, so `followSystemRegister` subscribed to `(prefers-color-scheme:
 * dark)` — the exact inversion a contributor writes by hand — kept every test in this file green while
 * shipping an app that goes light when the OS goes dark. Here an unexpected query gets the inverted
 * answer (which fails the behavioural tests) and the queries asked for are recorded (which fails the
 * pin below), so the mistake cannot be green twice.
 */
function fakeMatchMedia(initiallyLight: boolean) {
  const listeners = new Set<(e: { matches: boolean }) => void>();
  const asked: string[] = [];
  const query = {
    matches: initiallyLight,
    addEventListener: (_: string, fn: (e: { matches: boolean }) => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: (e: { matches: boolean }) => void) => listeners.delete(fn),
  };
  const view = {
    matchMedia: (media: string) => {
      asked.push(media);
      return media === LIGHT_QUERY ? query : { ...query, matches: !query.matches };
    },
  } as unknown as Window;
  const emit = (matches: boolean): void => {
    query.matches = matches;
    for (const fn of listeners) fn({ matches });
  };
  return { view, emit, asked, listenerCount: () => listeners.size };
}

beforeEach(() => {
  document.head.innerHTML = '';
  document.documentElement.removeAttribute('data-register');
});

describe('installing the token layer', () => {
  it('selects a register so nothing can paint against unresolved properties', () => {
    installTokens();
    expect(document.documentElement.getAttribute('data-register')).toBe('dark');
    expect(document.getElementById('wigolo-tokens')!.textContent).toContain('--agent:');
  });

  it('puts the layer first in the head, ahead of anything that resolves against it', () => {
    const other = document.createElement('style');
    document.head.append(other);
    installTokens();
    expect(document.head.firstChild).toBe(document.getElementById('wigolo-tokens'));
  });

  it('is idempotent — a second install rewrites one element rather than stacking layers', () => {
    installTokens();
    installTokens();
    expect(document.querySelectorAll('#wigolo-tokens')).toHaveLength(1);
  });

  it('does not overwrite a register that has already been chosen', () => {
    // Install runs on every renderer boot. If it reset the register, a window reopened while the
    // system was light would flash dark and then correct itself.
    setRegister('light');
    installTokens();
    expect(currentRegister()).toBe('light');
  });
});

describe('switching register', () => {
  it('changes register without touching the stylesheet or the DOM tree', () => {
    // The whole point: a register change must not be a reason to reload a window that is driving a
    // tab, so the switch may only move an attribute.
    installTokens();
    const style = document.getElementById('wigolo-tokens')!;
    const css = style.textContent;
    setRegister('light');
    expect(currentRegister()).toBe('light');
    expect(document.getElementById('wigolo-tokens')).toBe(style);
    expect(style.textContent).toBe(css);
  });

  it('reads an unknown or absent attribute as the default register', () => {
    expect(currentRegister()).toBe('dark');
    document.documentElement.setAttribute('data-register', 'sepia');
    expect(currentRegister()).toBe('dark');
  });
});

describe('following the system appearance', () => {
  it('reports the register the OS is asking for', () => {
    expect(systemRegister(fakeMatchMedia(true).view)).toBe('light');
    expect(systemRegister(fakeMatchMedia(false).view)).toBe('dark');
  });

  it('asks the OS the one question whose answer maps to a register, in both entry points', () => {
    // The pin. Both functions read `prefers-color-scheme: light` and treat a match as §11 — asking the
    // inverted question is a one-word edit that inverts the whole app, and every behavioural assertion
    // here is written against a fake, so the fake is where that has to be caught.
    const direct = fakeMatchMedia(true);
    systemRegister(direct.view);
    expect(direct.asked).toEqual([LIGHT_QUERY]);

    const followed = fakeMatchMedia(true);
    followSystemRegister(followed.view, document)();
    expect(followed.asked).toEqual([LIGHT_QUERY]);
  });

  it('adopts the system register immediately and then tracks changes to it', () => {
    const media = fakeMatchMedia(true);
    followSystemRegister(media.view, document);
    expect(currentRegister()).toBe('light');
    media.emit(false);
    expect(currentRegister()).toBe('dark');
    media.emit(true);
    expect(currentRegister()).toBe('light');
  });

  it('stops tracking when unsubscribed', () => {
    const media = fakeMatchMedia(false);
    const stop = followSystemRegister(media.view, document);
    expect(media.listenerCount()).toBe(1);
    stop();
    expect(media.listenerCount()).toBe(0);
    media.emit(true);
    expect(currentRegister()).toBe('dark');
  });

  it('degrades to a no-op where matchMedia is unavailable', () => {
    const view = {} as Window;
    expect(systemRegister(view)).toBe('dark');
    expect(() => followSystemRegister(view, document)()).not.toThrow();
  });
});

describe('the layer is generated, not shipped', () => {
  it('emits every register block into the one installed element', () => {
    // A second stylesheet is the failure mode this design exists to prevent: two files drift, and
    // the drift only shows in whichever register the author was not looking at.
    const css = installTokens().textContent!;
    expect(css).toContain(':root[data-register="dark"]');
    expect(css).toContain(':root[data-register="light"]');
    expect(document.querySelectorAll('style')).toHaveLength(1);
  });

  it('does not fetch anything — the content-security policy forbids an external stylesheet', () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    installTokens();
    expect(spy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
