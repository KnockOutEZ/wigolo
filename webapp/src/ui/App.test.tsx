import { describe, it, expect, afterEach, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { App } from './App.js';

/**
 * Split-view shell tests (S7). A no-op `connect` is injected so the pane renders without attempting a live
 * stream (the default bootstrap also no-ops without a WebSocket, but injecting keeps the test explicit).
 */
describe('Studio web-app split-view shell', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  function mount() {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const connect = vi.fn(() => () => {});
    act(() => {
      render(<App connect={connect} />, host);
    });
    return { host, connect };
  }

  it('renders the split view: a browser pane (canvas) and the session rail', () => {
    const { host, connect } = mount();
    expect(host.querySelector('.studio-split')).not.toBeNull();
    expect(host.querySelector('canvas.studio-canvas')).not.toBeNull();
    expect(host.querySelector('aside.studio-rail')).not.toBeNull();
    expect(host.textContent).toContain('wigolo studio');
    // the pane wires the live stream onto its canvas
    expect(connect).toHaveBeenCalledOnce();
    expect(connect.mock.calls[0][0]).toBeInstanceOf(HTMLCanvasElement);
  });

  // GUARDRAIL PIN (S7): no implementation/dependency name appears anywhere in the served UI text — capability
  // language only. NAMED mutation that REDs: add any banned name to a component's copy (e.g. "Powered by
  // Playwright" in the rail) → it lands in the rendered text and this assertion fails.
  it('GUARDRAIL: the served UI uses capability language only — no dependency/implementation names', () => {
    const { host } = mount();
    const text = (host.textContent ?? '').toLowerCase();
    const banned = ['preact', 'playwright', 'chromium', 'searxng', 'cdp', 'trafilatura', 'esbuild', 'sqlite', 'onnx', 'fastembed', 'websocket', 'jsdom'];
    for (const name of banned) {
      expect(text, `served UI must not mention "${name}"`).not.toContain(name);
    }
  });
});
