import { describe, it, expect, afterEach, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { ControlsModel } from '../transport/controls.js';
import { DriveIndicator } from './DriveIndicator.js';
import { ControlHandoff } from './ControlHandoff.js';

/**
 * Control-handoff UI (S2). The human (default driver) hands the token to the agent or takes it back. Each
 * action emits a {t:'control', op, to?} up-message THROUGH THE CODEC — and crucially does NOT flip the
 * who's-driving indicator locally; the holder changes only when the host echoes a {t:'control'} down-message.
 */
describe('ControlHandoff — emit control ops via the codec', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  function mount(node: preact.ComponentChild) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    act(() => {
      render(node as never, host);
    });
    return host;
  }

  function click(host: HTMLElement, label: string) {
    const btn = [...host.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes(label));
    if (!btn) throw new Error(`button not found: ${label}`);
    act(() => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  }

  // PIN (wiring value-flip). NAMED mutation that REDs: change the grant action to emit the wrong op
  // (e.g. up.control('release', ...)) or the wrong message type (e.g. up.nav) → the parsed payload no longer
  // equals {t:'control', op:'grant', to:'agent'} and this assertion fails.
  it('PIN: human "hand to agent" emits {t:control, op:grant, to:agent} through encodeUp', () => {
    const onEmit = vi.fn();
    const host = mount(<ControlHandoff holder="human" onEmit={onEmit} />);
    click(host, 'agent');
    expect(onEmit).toHaveBeenCalledOnce();
    expect(JSON.parse(onEmit.mock.calls[0][0])).toEqual({ t: 'control', op: 'grant', to: 'agent' });
  });

  it('PIN: agent-holder "take back" emits {t:control, op:reclaim} (no target)', () => {
    const onEmit = vi.fn();
    const host = mount(<ControlHandoff holder="agent" onEmit={onEmit} />);
    click(host, 'back');
    expect(onEmit).toHaveBeenCalledOnce();
    expect(JSON.parse(onEmit.mock.calls[0][0])).toEqual({ t: 'control', op: 'reclaim' });
  });

  // PIN (no optimistic flip): emitting an op must NOT change the indicator until the SERVER echoes a control
  // message. NAMED mutation that REDs: have the handoff click also call model.applyServer locally (optimistic)
  // → the indicator flips to the agent before any server echo and the "still You" assertion fails.
  it('PIN: a handoff emit does NOT locally flip the indicator absent a server control echo', () => {
    const model = new ControlsModel();
    const onEmit = vi.fn(); // the real wiring sends to the host; it never touches the model
    const host = mount(
      <div>
        <DriveIndicator model={model} />
        <ControlHandoff holder={model.snapshot().holder} onEmit={onEmit} />
      </div>,
    );
    click(host, 'agent');
    expect(host.textContent).toContain('You are driving'); // no optimistic flip
    act(() => model.applyServer('agent', 1)); // the server echo is what actually flips it
    expect(host.textContent).toContain('Agent is driving');
  });
});
