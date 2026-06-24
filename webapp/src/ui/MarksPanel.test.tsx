import { describe, it, expect, afterEach } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { MarksModel } from '../transport/marks.js';
import { MarksPanel } from './MarksPanel.js';

/**
 * The marks-list panel (7c S4) — the human read surface for their marked elements. It renders each mark's
 * markId/role/name/confidence from the SERVER-authoritative MarksModel, and every page-derived string goes
 * through SafeText so a mark named with markup can never inject. Applies the post-hello snapshot then live
 * deltas; it never adds a mark the server didn't send.
 */
describe('MarksPanel — human marks read surface', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  function mount(model: MarksModel) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    act(() => {
      render(<MarksPanel model={model} />, host);
    });
    return host;
  }

  it('renders a mark’s descriptor + confidence from the model', () => {
    const model = new MarksModel();
    const host = mount(model);
    act(() => model.applyDelta({ markId: 'm1', role: 'button', name: 'Add to cart', confidence: 'high' }));
    const text = host.textContent ?? '';
    expect(text).toContain('m1');
    expect(text).toContain('button');
    expect(text).toContain('Add to cart');
    expect(text).toContain('high');
  });

  it('shows an empty state before any mark', () => {
    const host = mount(new MarksModel());
    expect(host.querySelector('.studio-marks')).not.toBeNull();
    expect(host.querySelector('.studio-mark')).toBeNull(); // no rows
  });

  // PIN-A (trust at the panel seam — reuses S1). A {t:'mark'} delta whose NAME carries markup MUST render as
  // LITERAL text: SafeText emits it as a text node, so no element parses out of it. NAMED mutation that REDs:
  // make the panel render the name via dangerouslySetInnerHTML (bypass SafeText) → the browser parses the
  // markup, an <img> materializes and querySelector finds it.
  it('PIN-A: a mark delta name carrying markup renders as LITERAL text, parsing no element', () => {
    const model = new MarksModel();
    const host = mount(model);
    const malicious = '<img src=x onerror="window.__pwned=1">';
    act(() => model.applyDelta({ markId: 'm1', role: 'button', name: malicious, confidence: 'high' }));
    expect(host.querySelector('img')).toBeNull(); // markup did not parse into a live element
    expect(host.textContent).toContain(malicious); // shown as the exact literal characters
  });

  // PIN-B at the panel: the list is server-authoritative — no row exists until a server message feeds the model.
  it('PIN-B: renders no rows until the server feeds the model (no optimistic local add)', () => {
    const model = new MarksModel();
    const host = mount(model);
    expect(host.querySelectorAll('.studio-mark').length).toBe(0); // nothing before a server snapshot/delta
    act(() => model.applySnapshot([{ markId: 'm1', role: 'button', name: 'A', confidence: 'high' }]));
    expect(host.querySelectorAll('.studio-mark').length).toBe(1); // appears only on the server snapshot
  });

  // GUARDRAIL (inherited, 7b-1-strengthened): capability language only — no dependency/implementation name in
  // any user-facing string OR visible attribute. NAMED mutation that REDs: put a banned name in the copy/attrs.
  it('GUARDRAIL: marks panel copy uses capability language only — no dependency/implementation names', () => {
    const model = new MarksModel();
    const host = mount(model);
    act(() => model.applyDelta({ markId: 'm1', role: 'button', name: 'A', confidence: 'high' }));
    let surface = (host.textContent ?? '').toLowerCase();
    for (const el of host.querySelectorAll('*')) {
      for (const attr of ['placeholder', 'aria-label', 'title', 'value', 'data-confidence']) {
        surface += ' ' + (el.getAttribute(attr) ?? '').toLowerCase();
      }
    }
    const banned = ['preact', 'playwright', 'chromium', 'searxng', 'cdp', 'esbuild', 'sqlite', 'onnx', 'fastembed', 'websocket', 'jsdom'];
    for (const name of banned) {
      expect(surface, `marks panel must not mention "${name}"`).not.toContain(name);
    }
  });
});
