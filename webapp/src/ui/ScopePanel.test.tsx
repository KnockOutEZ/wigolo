import { describe, it, expect, afterEach, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { ScopePanel } from './ScopePanel.js';

/**
 * The pre-grant scope panel (S7) — the human authorizes-in-advance a domain + action-type + risk-tier. Submit
 * emits {t:'grant', entries:[...]} THROUGH THE CODEC; it is the ONLY agent-action authorization surface and is
 * SEPARATE from the approval card. Copy is capability language only.
 */
describe('ScopePanel — human pre-grant authorization surface', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  function mount(onEmit: (wire: string) => void = vi.fn()) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    act(() => {
      render(<ScopePanel emit={onEmit} />, host);
    });
    return host;
  }

  it('submitting a domain emits {t:grant, entries:[{domain, actionType, riskTier}]} through the codec and clears the input', () => {
    const onEmit = vi.fn();
    const host = mount(onEmit);
    const input = host.querySelector('.studio-scope-domain') as HTMLInputElement;
    act(() => {
      input.value = 'shop.example';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const form = host.querySelector('form.studio-scope-form') as HTMLFormElement;
    const ev = new Event('submit', { bubbles: true, cancelable: true });
    act(() => { form.dispatchEvent(ev); });
    expect(ev.defaultPrevented).toBe(true);
    expect(onEmit).toHaveBeenCalledOnce();
    // defaults: actionType 'click', riskTier 'money'
    expect(JSON.parse(onEmit.mock.calls[0][0])).toEqual({ t: 'grant', entries: [{ domain: 'shop.example', actionType: 'click', riskTier: 'money' }] });
    expect((host.querySelector('.studio-scope-domain') as HTMLInputElement).value).toBe('');
  });

  it('ignores an empty submit (no grant emitted)', () => {
    const onEmit = vi.fn();
    const host = mount(onEmit);
    const form = host.querySelector('form.studio-scope-form') as HTMLFormElement;
    act(() => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(onEmit).not.toHaveBeenCalled();
  });

  it('GUARDRAIL: scope panel copy uses capability language only — no dependency/implementation names', () => {
    const host = mount();
    let surface = (host.textContent ?? '').toLowerCase();
    for (const el of host.querySelectorAll('*')) {
      for (const attr of ['placeholder', 'aria-label', 'title', 'value']) {
        surface += ' ' + (el.getAttribute(attr) ?? '').toLowerCase();
      }
    }
    const banned = ['preact', 'playwright', 'chromium', 'searxng', 'cdp', 'esbuild', 'sqlite', 'onnx', 'fastembed', 'websocket', 'jsdom'];
    for (const name of banned) {
      expect(surface, `scope panel must not mention "${name}"`).not.toContain(name);
    }
  });
});
