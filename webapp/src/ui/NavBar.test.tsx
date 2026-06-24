import { describe, it, expect, afterEach, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { NavBar } from './NavBar.js';

/**
 * Navigation URL bar (S3). The human types a URL and submits; the bar emits a {t:'nav', url} up-message
 * THROUGH THE CODEC. It performs NO client-side navigation and holds NO SSRF logic — the host owns the
 * navigation guard (human → localhost allowed). The only side effect of a submit is the codec emit.
 */
describe('NavBar — emit nav requests via the codec', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  function mount(onEmit: (wire: string) => void) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    act(() => {
      render(<NavBar onEmit={onEmit} />, host);
    });
    return host;
  }

  function type(host: HTMLElement, value: string) {
    const input = host.querySelector('input') as HTMLInputElement;
    act(() => {
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  function submit(host: HTMLElement): Event {
    const form = host.querySelector('form') as HTMLFormElement;
    const ev = new Event('submit', { bubbles: true, cancelable: true });
    act(() => form.dispatchEvent(ev));
    return ev;
  }

  // PIN (wiring value-flip). NAMED mutation that REDs: change submit to emit the wrong type (e.g.
  // up.control instead of up.nav) or to call a non-nav side effect (e.g. window.location assignment instead
  // of onEmit) → the parsed payload no longer equals {t:'nav', url} (or onEmit is never called) and this fails.
  it('PIN: submitting a URL emits {t:nav, url} through encodeUp', () => {
    const onEmit = vi.fn();
    const host = mount(onEmit);
    type(host, 'https://example.com/path');
    submit(host);
    expect(onEmit).toHaveBeenCalledOnce();
    expect(JSON.parse(onEmit.mock.calls[0][0])).toEqual({ t: 'nav', url: 'https://example.com/path' });
  });

  it('performs no client-side navigation — the submit default is prevented', () => {
    const host = mount(vi.fn());
    type(host, 'https://example.com');
    const ev = submit(host);
    expect(ev.defaultPrevented).toBe(true);
  });

  it('ignores an empty submit (no nav emitted)', () => {
    const onEmit = vi.fn();
    const host = mount(onEmit);
    submit(host);
    expect(onEmit).not.toHaveBeenCalled();
  });
});
