import { describe, it, expect, afterEach } from 'vitest';
import { render } from 'preact';
import { App } from './App.js';

/**
 * Smoke test for the Studio web-app shell — proves the whole component lane works end-to-end (Preact render
 * + jsdom DOM + the esbuild Preact-JSX transform under the new `webapp` vitest project). S7 expands this
 * into the split-view assertions; here it just guarantees the shell mounts and carries no dependency-name
 * leakage in its user-facing copy (the S7 guardrail, asserted early).
 */
describe('Studio web-app shell', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('mounts into the DOM and renders the shell heading', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    render(<App />, host);
    expect(host.querySelector('#studio-root')).not.toBeNull();
    expect(host.textContent).toContain('wigolo studio');
  });

  it('uses capability language only — no implementation/dependency names in the served copy', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    render(<App />, host);
    const text = (host.textContent ?? '').toLowerCase();
    for (const banned of ['preact', 'playwright', 'searxng', 'chromium', 'cdp', 'trafilatura']) {
      expect(text).not.toContain(banned);
    }
  });
});
