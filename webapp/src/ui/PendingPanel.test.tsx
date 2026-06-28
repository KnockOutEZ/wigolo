import { describe, it, expect, afterEach } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { ParkedModel } from '../transport/parked.js';
import { PendingPanel } from './PendingPanel.js';

/**
 * The pending-review panel (S7) — risky agent actions parked because no pre-grant matched. Read-only; the
 * page-derived `domain` renders via SafeText (inert). Copy is capability language only.
 */
describe('PendingPanel — parked-actions review surface', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  function mount(model: ParkedModel) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    act(() => { render(<PendingPanel model={model} />, host); });
    return host;
  }

  it('renders a parked action from the model', () => {
    const model = new ParkedModel();
    const host = mount(model);
    act(() => model.applyDelta({ action: 'click', risk: 'money', domain: 'shop.example' }));
    expect(host.textContent).toContain('click');
    expect(host.textContent).toContain('money');
    expect(host.textContent).toContain('shop.example');
  });

  it('renders nothing when empty (an interrupt surface, like the approval card)', () => {
    const host = mount(new ParkedModel());
    expect(host.querySelector('.studio-pending')).toBeNull(); // absent until something is parked
  });

  // PIN — the page-derived domain renders as LITERAL text via SafeText (markup never parses into an element).
  // NAMED mutation that REDs: render the domain via dangerouslySetInnerHTML → the <img> materializes.
  it('PIN: a parked action whose domain carries markup renders as LITERAL text, parsing no element', () => {
    const model = new ParkedModel();
    const host = mount(model);
    const malicious = '<img src=x onerror="window.__pwned=1">';
    act(() => model.applyDelta({ action: 'click', risk: 'money', domain: malicious }));
    expect(host.querySelector('img')).toBeNull();
    expect(host.textContent).toContain(malicious);
  });
});
