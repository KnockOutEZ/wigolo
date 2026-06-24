import { describe, it, expect, afterEach } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { TimelineModel } from '../transport/timeline.js';
import type { AuditView } from '../transport/codec.js';
import { TimelinePanel } from './TimelinePanel.js';

const entry = (seq: number, over: Partial<AuditView> = {}): AuditView => ({
  seq,
  ts: 1000 + seq,
  action: 'navigate',
  epoch: 0,
  outcome: { ok: true },
  ...over,
});

/**
 * The activity-timeline panel (7d S4) — the human's read surface for the audit trail. It mirrors the
 * SERVER-authoritative TimelineModel (post-hello snapshot REPLACE + live deltas APPEND) and renders each
 * entry's action / outcome / risk / target / ts. target.url/ref are host-relayed but may echo page-derived
 * content, so every such string goes through SafeText (inert text). The panel adds nothing optimistically.
 */
describe('TimelinePanel — audit timeline read surface', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  function mount(model: TimelineModel) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    act(() => {
      render(<TimelinePanel model={model} />, host);
    });
    return host;
  }

  it('renders an entry’s action + outcome + risk + target from the model', () => {
    const model = new TimelineModel();
    const host = mount(model);
    act(() => model.applyDelta(entry(1, { action: 'click', outcome: { ok: false, error_reason: 'element_occluded' }, risk: 'money', target: { url: 'https://shop.test/buy' } })));
    const text = host.textContent ?? '';
    expect(text).toContain('click');
    expect(text).toContain('money');
    expect(text).toContain('https://shop.test/buy');
    expect(text).toContain('element_occluded');
  });

  it('shows an empty state before any entry', () => {
    const host = mount(new TimelineModel());
    expect(host.querySelector('.studio-timeline')).not.toBeNull();
    expect(host.querySelector('.studio-timeline-entry')).toBeNull();
  });

  // PIN-A (trust at the panel seam — reuses S1/SafeText). A delta target.url carrying markup MUST render as
  // LITERAL text. NAMED mutation that REDs: render the target via dangerouslySetInnerHTML (bypass SafeText) →
  // the markup parses, an <img> materializes and querySelector finds it.
  it('PIN-A: a delta target.url carrying markup renders as LITERAL text, parsing no element', () => {
    const model = new TimelineModel();
    const host = mount(model);
    const malicious = '<img src=x onerror="window.__pwned=1">';
    act(() => model.applyDelta(entry(1, { action: 'navigate', target: { url: malicious } })));
    expect(host.querySelector('img')).toBeNull();
    expect(host.textContent).toContain(malicious);
  });

  // PIN-B (authoritative snapshot at the panel). A fresh snapshot REPLACES what is shown. NAMED mutation that
  // REDs: make the model merge instead of replace → the stale row survives and the rendered row count / seq
  // diverges from the fresh snapshot.
  it('PIN-B: a fresh applySnapshot replaces the rendered rows — a stale entry does not linger', () => {
    const model = new TimelineModel();
    const host = mount(model);
    act(() => model.applySnapshot([entry(9, { action: 'stale-old' })]));
    expect(host.textContent).toContain('stale-old');
    act(() => model.applySnapshot([entry(51, { action: 'fresh-a' }), entry(52, { action: 'fresh-b' })]));
    expect(host.querySelectorAll('.studio-timeline-entry').length).toBe(2);
    expect(host.textContent).not.toContain('stale-old'); // replaced, not merged
  });

  // GUARDRAIL (inherited, 7b-1-strengthened): capability language only — no dependency/implementation name in
  // any user-facing string OR visible attribute.
  it('GUARDRAIL: timeline copy uses capability language only — no dependency/implementation names', () => {
    const model = new TimelineModel();
    const host = mount(model);
    act(() => model.applyDelta(entry(1, { action: 'click', risk: 'money', target: { url: 'https://shop.test/buy' } })));
    let surface = (host.textContent ?? '').toLowerCase();
    for (const el of host.querySelectorAll('*')) {
      for (const attr of ['placeholder', 'aria-label', 'title', 'value', 'data-risk', 'data-ok']) {
        surface += ' ' + (el.getAttribute(attr) ?? '').toLowerCase();
      }
    }
    const banned = ['preact', 'playwright', 'chromium', 'searxng', 'cdp', 'esbuild', 'sqlite', 'onnx', 'fastembed', 'websocket', 'jsdom'];
    for (const name of banned) {
      expect(surface, `timeline must not mention "${name}"`).not.toContain(name);
    }
  });
});
