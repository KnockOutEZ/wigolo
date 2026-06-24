import { describe, it, expect, afterEach, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { App, deriveRailProps } from './App.js';
import { ControlsModel } from '../transport/controls.js';
import { MarksModel } from '../transport/marks.js';

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

  // 7c S4 — closes a latent 7b-1 wiring gap: App must hand the LIVE bootstrap wiring to the rail. The prior
  // code read `boot?.controls`, a field bootstrapStudio never returns → the rail was inert in production
  // (tests passed only because they inject `controls`). deriveRailProps maps the wiring explicitly. NAMED
  // mutation that REDs: derive the rail's controls from `boot.controls` (undefined) → controls is undefined
  // and the live model never reaches the rail.
  it('deriveRailProps maps the live wiring to the rail (controls + marks both reach it)', () => {
    const model = new ControlsModel();
    const marks = new MarksModel();
    const wiring = { model, marks, emit: vi.fn(), connectCanvas: vi.fn(() => () => {}) };
    const props = deriveRailProps(wiring);
    expect(props.controls?.model).toBe(model); // the SAME live control model, not undefined
    expect(props.controls?.emit).toBe(wiring.emit);
    expect(props.marks).toBe(marks); // and the live marks model
  });

  it('deriveRailProps returns nothing when there is no wiring (jsdom/no-WebSocket)', () => {
    expect(deriveRailProps(null)).toEqual({});
  });

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
