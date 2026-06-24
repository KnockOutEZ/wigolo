import { describe, it, expect, afterEach } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { ArtifactsModel } from '../transport/artifacts.js';
import { CapturedPanel } from './CapturedPanel.js';

/**
 * The captured-items panel (7e S3) — the human's read surface for clips/qa captured this session. It mirrors
 * the SERVER-authoritative ArtifactsModel (post-hello snapshot + live deltas) and renders each item's
 * title/url (page-derived → SafeText, inert) plus a trusted|untrusted badge. No optimistic add. Copy is
 * capability language only.
 *
 * VALUE-FLIP PINS (R2-verified). PIN-A/B/C below are mutation-verified against the PRESENT components —
 * applying ONLY the named mutation REDs the pin with the diverging value shown, so none passes vacuously.
 */
describe('CapturedPanel — captured-items read surface', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  function mount(model: ArtifactsModel) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    act(() => {
      render(<CapturedPanel model={model} />, host);
    });
    return host;
  }

  const item = (over: Partial<{ id: number; type: string; title: string; url: string; trusted: boolean; created_at: string }> = {}) => ({
    id: over.id ?? 1,
    type: over.type ?? 'clip',
    title: over.title ?? 'Great deal',
    url: over.url ?? 'https://x.example/1',
    trusted: over.trusted ?? false,
    created_at: over.created_at ?? '2026-06-24T00:00:00.000Z',
  });

  it('renders a captured item from the server-authoritative model', () => {
    const model = new ArtifactsModel();
    const host = mount(model);
    act(() => model.applyDelta(item({ title: 'Great deal', url: 'https://x.example/1' })));
    expect(host.textContent).toContain('Great deal');
    expect(host.textContent).toContain('https://x.example/1');
  });

  it('shows an empty state before any captured item', () => {
    const host = mount(new ArtifactsModel());
    expect(host.querySelector('.studio-captured')).not.toBeNull();
    expect(host.querySelector('.studio-captured-item')).toBeNull(); // no rows
  });

  // PIN-A (trust at the panel seam). A title/url carrying markup MUST render as LITERAL text via SafeText.
  // NAMED mutation that REDs: render the value via dangerouslySetInnerHTML (bypass SafeText) → the browser
  // parses the markup and an <img> materializes (RED: querySelector('img') ≠ null).
  it('PIN-A: a title/url carrying markup renders as LITERAL text, parsing no element', () => {
    const model = new ArtifactsModel();
    const host = mount(model);
    const malicious = '<img src=x onerror="window.__pwned=1">';
    act(() => model.applyDelta(item({ title: malicious, url: malicious })));
    expect(host.querySelector('img')).toBeNull(); // markup did not parse into a live element
    expect(host.textContent).toContain(malicious); // shown as exact literal characters
  });

  // PIN-B (trusted badge correctness — the captured-panel trust surface). NAMED mutation that REDs: ignore or
  // invert the trusted field → a trusted=0 item shows as trusted (RED: badge 'trusted' ≠ 'untrusted').
  it('PIN-B: a trusted=0 item badges UNTRUSTED and a trusted=1 item badges TRUSTED', () => {
    const model = new ArtifactsModel();
    const host = mount(model);
    act(() => model.applySnapshot([item({ id: 1, trusted: false }), item({ id: 2, trusted: true })]));
    const rows = host.querySelectorAll('.studio-captured-item');
    const badge = (li: Element) => (li.querySelector('.studio-captured-trust')?.textContent ?? '').toLowerCase();
    expect(badge(rows[0])).toBe('untrusted'); // trusted=0
    expect(badge(rows[1])).toBe('trusted');   // trusted=1 — mutation that ignores/inverts trusted REDs here
  });

  // PIN-C (authoritative snapshot at the panel — replace, not merge). NAMED mutation that REDs: applySnapshot
  // merges (`[...this.items, ...items]`) instead of replacing → a stale item survives (RED: text contains 'stale').
  it('PIN-C: a fresh snapshot replaces the list (a stale item does not survive)', () => {
    const model = new ArtifactsModel();
    const host = mount(model);
    act(() => model.applyDelta(item({ id: 1, title: 'stale' })));
    act(() => model.applySnapshot([item({ id: 2, title: 'fresh' })]));
    expect(host.textContent).toContain('fresh');
    expect(host.textContent).not.toContain('stale'); // replaced, not merged
  });

  // GUARDRAIL (inherited): capability language only — no dependency/implementation name in any user-facing
  // string OR visible attribute.
  it('GUARDRAIL: captured panel copy uses capability language only — no dependency/implementation names', () => {
    const model = new ArtifactsModel();
    const host = mount(model);
    act(() => model.applyDelta(item()));
    let surface = (host.textContent ?? '').toLowerCase();
    for (const el of host.querySelectorAll('*')) {
      for (const attr of ['placeholder', 'aria-label', 'title', 'value']) {
        surface += ' ' + (el.getAttribute(attr) ?? '').toLowerCase();
      }
    }
    const banned = ['preact', 'playwright', 'chromium', 'searxng', 'cdp', 'esbuild', 'sqlite', 'onnx', 'fastembed', 'websocket', 'jsdom'];
    for (const name of banned) {
      expect(surface, `captured panel must not mention "${name}"`).not.toContain(name);
    }
  });
});
