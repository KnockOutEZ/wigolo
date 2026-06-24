import { describe, it, expect, afterEach, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { ControlsModel } from '../transport/controls.js';
import { Rail } from './Rail.js';

/**
 * The rail (S4) now mounts the direct-drive controls panel as its FIRST panel, wired to the live
 * connection's model + codec emit. With no controls injected (the jsdom/no-op path) it renders inertly.
 */
describe('Rail — controls mounted as the first panel', () => {
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

  it('renders the controls panel as the first rail child', () => {
    const host = mount(<Rail controls={{ model: new ControlsModel(), emit: vi.fn() }} />);
    const rail = host.querySelector('aside.studio-rail') as HTMLElement;
    expect(rail.firstElementChild?.classList.contains('studio-controls')).toBe(true);
    expect(rail.querySelector('.studio-driving')).not.toBeNull();
  });

  it('renders inertly with a default model when no controls are injected', () => {
    const host = mount(<Rail />);
    expect(host.querySelector('aside.studio-rail')).not.toBeNull();
    expect(host.querySelector('.studio-controls')).not.toBeNull();
  });
});
