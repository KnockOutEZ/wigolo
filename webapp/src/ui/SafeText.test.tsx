import { describe, it, expect, afterEach } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { SafeText } from './SafeText.js';

/**
 * SafeText (S1) — the shared rail trust primitive. Every page-derived string the rail shows the human
 * (a mark's role/name) is UNTRUSTED DATA: a page can name an element `<img src=x onerror=…>`. SafeText
 * renders such a value as LITERAL TEXT — the markup never parses into live DOM, never executes — which is
 * what lets the marks panel (S4) show page content without a script-injection surface.
 */
describe('SafeText — inert render of page-derived strings', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  function mount(value: string) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    act(() => {
      render(<SafeText value={value} />, host);
    });
    return host;
  }

  it('renders a plain string as its text', () => {
    const host = mount('Add to cart');
    expect(host.textContent).toBe('Add to cart');
  });

  // PIN (trust — the load-bearing one). A mark name carrying markup MUST render as literal text: the
  // characters appear verbatim and NO element is parsed out of them. NAMED mutation that REDs: make SafeText
  // emit the value via dangerouslySetInnerHTML instead of as a text child → the browser parses the markup,
  // an <img> element materializes in the DOM (querySelector finds it) and the textContent is no longer the
  // raw string. Value-flip in the render mechanism, not module-absence.
  it('PIN: renders a markup-bearing name as LITERAL text, parsing no element', () => {
    const malicious = '<img src=x onerror="window.__pwned=1">';
    const host = mount(malicious);
    // The markup did not parse into a live element — no injection surface.
    expect(host.querySelector('img')).toBeNull();
    // It shows as the exact literal characters instead.
    expect(host.textContent).toBe(malicious);
  });
});
