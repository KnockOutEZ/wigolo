import { describe, it, expect, afterEach } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { ControlsModel } from '../transport/controls.js';
import { DriveIndicator } from './DriveIndicator.js';

/**
 * Who's-driving indicator (S1). It renders the holder from the SERVER-authoritative ControlsModel ONLY —
 * never a local/optimistic guess — so a forged or stale holder can never be shown to the human.
 */
describe('DriveIndicator — who is driving', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  function mount(model: ControlsModel) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    act(() => {
      render(<DriveIndicator model={model} />, host);
    });
    return host;
  }

  it('shows the human as the default driver', () => {
    const host = mount(new ControlsModel());
    expect(host.textContent).toContain('You are driving');
    expect(host.querySelector('.studio-driving')?.getAttribute('data-holder')).toBe('human');
  });

  // PIN-A (server-authoritative). NAMED mutation that REDs: make the indicator read a local/optimistic holder
  // (e.g. a captured-once snapshot or a hardcoded 'human') instead of the live server state → after the server
  // hands control to the agent the indicator still shows the human, so these assertions fail.
  it('PIN-A: reflects the holder the SERVER reports, not a local guess', () => {
    const model = new ControlsModel();
    const host = mount(model);
    act(() => model.applyServer('agent', 1));
    expect(host.textContent).toContain('Agent is driving');
    expect(host.querySelector('.studio-driving')?.getAttribute('data-holder')).toBe('agent');
  });

  it('PIN-A: a stale server message cannot roll the displayed holder back', () => {
    const model = new ControlsModel();
    const host = mount(model);
    act(() => model.applyServer('agent', 2));
    act(() => model.applyServer('human', 1)); // stale
    expect(host.textContent).toContain('Agent is driving');
  });
});
