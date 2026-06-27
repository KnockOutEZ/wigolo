import { describe, it, expect, afterEach } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { NarrationModel } from '../transport/narration.js';
import { NarrationPanel } from './NarrationPanel.js';

/**
 * The narration panel (S2b) — the agent→human running commentary, read-only. Every narration is AGENT-authored
 * (untrusted on this surface) and rendered via SafeText so a narration carrying markup can never inject. The
 * list mirrors the ephemeral NarrationModel (append-only live deltas; no backfill). Copy is capability-only.
 */
describe('NarrationPanel — agent narration read surface', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  function mount(model: NarrationModel) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    act(() => {
      render(<NarrationPanel model={model} />, host);
    });
    return host;
  }

  it('renders a narration from the model', () => {
    const model = new NarrationModel();
    const host = mount(model);
    act(() => model.applyDelta('reading the reviews to compare prices'));
    expect(host.textContent).toContain('reading the reviews to compare prices');
  });

  it('shows an empty state before any narration', () => {
    const host = mount(new NarrationModel());
    expect(host.querySelector('.studio-narration')).not.toBeNull();
    expect(host.querySelector('.studio-narration-item')).toBeNull(); // no rows
  });

  // PIN-S2b (trust at the panel seam — the load-bearing guard). A narration whose TEXT carries markup MUST
  // render as LITERAL text: SafeText emits it as a text node, so no element parses out of it. This defuses a
  // page→agent→narration→UI injection-laundering path. NAMED mutation that REDs: render the text via
  // dangerouslySetInnerHTML (bypass SafeText) → the browser parses the markup and an <img> materializes.
  it('PIN-S2b: a narration carrying markup renders as LITERAL text, parsing no element', () => {
    const model = new NarrationModel();
    const host = mount(model);
    const malicious = '<img src=x onerror="window.__pwned=1">';
    act(() => model.applyDelta(malicious));
    expect(host.querySelector('img')).toBeNull(); // markup did not parse into a live element
    expect(host.textContent).toContain(malicious); // shown as the exact literal characters
  });

  // GUARDRAIL (inherited): capability language only — no dependency/implementation name in any user-facing
  // string OR visible attribute. NAMED mutation that REDs: put a banned name in the copy/attrs.
  it('GUARDRAIL: narration panel copy uses capability language only — no dependency/implementation names', () => {
    const model = new NarrationModel();
    const host = mount(model);
    act(() => model.applyDelta('a note'));
    let surface = (host.textContent ?? '').toLowerCase();
    for (const el of host.querySelectorAll('*')) {
      for (const attr of ['placeholder', 'aria-label', 'title', 'value']) {
        surface += ' ' + (el.getAttribute(attr) ?? '').toLowerCase();
      }
    }
    const banned = ['preact', 'playwright', 'chromium', 'searxng', 'cdp', 'esbuild', 'sqlite', 'onnx', 'fastembed', 'websocket', 'jsdom'];
    for (const name of banned) {
      expect(surface, `narration panel must not mention "${name}"`).not.toContain(name);
    }
  });
});
