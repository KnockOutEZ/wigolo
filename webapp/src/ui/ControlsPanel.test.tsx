import { describe, it, expect, afterEach, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { ControlsModel } from '../transport/controls.js';
import { ControlsPanel } from './ControlsPanel.js';

/**
 * The direct-drive controls panel (S4) — composes the who's-driving indicator, the control handoff, and the
 * nav URL bar over ONE server-authoritative ControlsModel and ONE codec emit. This is the wiring seam where a
 * tempting bug — flipping the holder optimistically on a local action — would live, so the no-optimistic-flip
 * property is pinned here.
 */
describe('ControlsPanel — direct-drive controls', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  function mount(model: ControlsModel, emit: (wire: string) => void) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    act(() => {
      render(<ControlsPanel model={model} emit={emit} />, host);
    });
    return host;
  }

  it('composes the indicator, handoff, and nav bar', () => {
    const host = mount(new ControlsModel(), vi.fn());
    expect(host.querySelector('.studio-driving')).not.toBeNull();
    expect(host.querySelector('.studio-handoff')).not.toBeNull();
    expect(host.querySelector('form.studio-nav')).not.toBeNull();
  });

  it('offers the contextual handoff for the server holder', () => {
    const model = new ControlsModel();
    const host = mount(model, vi.fn());
    expect(host.querySelector('.studio-handoff-grant')).not.toBeNull(); // human holds → offer grant
    act(() => model.applyServer('agent', 1));
    expect(host.querySelector('.studio-handoff-reclaim')).not.toBeNull(); // agent holds → offer reclaim
  });

  it('routes handoff and nav actions to the injected codec emit', () => {
    const emit = vi.fn();
    const host = mount(new ControlsModel(), emit);
    const grant = host.querySelector('.studio-handoff-grant') as HTMLButtonElement;
    act(() => {
      grant.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(JSON.parse(emit.mock.calls[0][0])).toEqual({ t: 'control', op: 'grant', to: 'agent' });
    const input = host.querySelector('input') as HTMLInputElement;
    act(() => {
      input.value = 'https://x.test';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      (host.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(JSON.parse(emit.mock.calls[1][0])).toEqual({ t: 'nav', url: 'https://x.test' });
  });

  // PIN (no optimistic flip — relocated to the wiring seam). NAMED mutation that REDs: wrap the emit passed
  // to the handoff so it ALSO calls model.applyServer locally (optimistic) → the indicator flips to the agent
  // before any server echo and the "still You" assertion fails.
  it('PIN: a handoff action does NOT optimistically flip the indicator — only the server echo does', () => {
    const model = new ControlsModel();
    const host = mount(model, vi.fn());
    const grant = host.querySelector('.studio-handoff-grant') as HTMLButtonElement;
    act(() => {
      grant.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(host.textContent).toContain('You are driving'); // not flipped by the local action
    act(() => model.applyServer('agent', 1)); // the host's control echo is what actually flips it
    expect(host.textContent).toContain('Agent is driving');
  });

  // GUARDRAIL PIN (inherited): the served controls use capability language only — no implementation/dependency
  // name appears in any USER-FACING string, including visible attributes (placeholder / aria-label / title)
  // not just text nodes. NAMED mutation that REDs: put any banned name in a control's copy OR a placeholder.
  it('GUARDRAIL: controls copy uses capability language only — no dependency/implementation names', () => {
    const host = mount(new ControlsModel(), vi.fn());
    let surface = (host.textContent ?? '').toLowerCase();
    for (const el of host.querySelectorAll('*')) {
      for (const attr of ['placeholder', 'aria-label', 'title', 'value']) {
        surface += ' ' + (el.getAttribute(attr) ?? '').toLowerCase();
      }
    }
    const banned = ['preact', 'playwright', 'chromium', 'searxng', 'cdp', 'esbuild', 'sqlite', 'onnx', 'fastembed', 'websocket', 'jsdom'];
    for (const name of banned) {
      expect(surface, `controls must not mention "${name}"`).not.toContain(name);
    }
  });
});
