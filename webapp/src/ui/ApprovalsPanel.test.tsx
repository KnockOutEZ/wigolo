import { describe, it, expect, afterEach, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { ApprovalsModel } from '../transport/approvals.js';
import { ApprovalsPanel } from './ApprovalsPanel.js';

/**
 * The approval card (7d S1). When the host holds a risky agent action it sends {t:'approval_request', id,
 * action, risk, target?} over the session WS; this panel renders each pending request as a card and emits the
 * human's verdict {t:'approval', id, decision} back through the codec. The server trusts the decision field
 * AND the WS is the human channel, so the GUI layer carries the safety property: only the explicit approve
 * control may emit 'approve', and a verdict must carry the request's EXACT id.
 */
describe('ApprovalsPanel — risky-action approval card', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  function mount(model: ApprovalsModel, emit: (wire: string) => void) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    act(() => {
      render(<ApprovalsPanel model={model} emit={emit} />, host);
    });
    return host;
  }

  function clickIn(scope: Element, selector: string) {
    const btn = scope.querySelector(selector) as HTMLButtonElement;
    if (!btn) throw new Error(`button not found: ${selector}`);
    act(() => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  }

  it('renders no card until the server sends a request, then one card per pending request', () => {
    const model = new ApprovalsModel();
    const host = mount(model, vi.fn());
    expect(host.querySelectorAll('.studio-approval').length).toBe(0);
    act(() => model.add({ id: 1, action: 'click', risk: 'money', target: { url: 'https://shop.test/buy' } }));
    expect(host.querySelectorAll('.studio-approval').length).toBe(1);
  });

  // PIN-A (client fail-closed — THE security pin). decision='approve' must fire ONLY from the explicit approve
  // control. NAMED mutation that REDs: point the deny handler at decision 'approve' → clicking Deny emits an
  // approval and this assertion (deny emits 'deny', never 'approve') fails.
  it('PIN-A: Approve emits decision=approve; Deny emits decision=deny (never approve)', () => {
    const model = new ApprovalsModel();
    const emit = vi.fn();
    const host = mount(model, emit);
    act(() => model.add({ id: 7, action: 'click', risk: 'money' }));
    clickIn(host, '.studio-approval-deny');
    expect(JSON.parse(emit.mock.calls[0][0])).toEqual({ t: 'approval', id: 7, decision: 'deny' });

    const model2 = new ApprovalsModel();
    const emit2 = vi.fn();
    const host2 = mount(model2, emit2);
    act(() => model2.add({ id: 8, action: 'click', risk: 'money' }));
    clickIn(host2, '.studio-approval-approve');
    expect(JSON.parse(emit2.mock.calls[0][0])).toEqual({ t: 'approval', id: 8, decision: 'approve' });
  });

  // PIN-A (exact id). A verdict must settle the SAME request the card shows. NAMED mutation that REDs: emit a
  // stale/wrong id (e.g. the first pending id instead of this card's) → the wrong request settles and the
  // approved id diverges from the card's id.
  it('PIN-A: the verdict carries the EXACT id of the card acted on (not a stale/sibling id)', () => {
    const model = new ApprovalsModel();
    const emit = vi.fn();
    const host = mount(model, emit);
    act(() => {
      model.add({ id: 1, action: 'click', risk: 'money' });
      model.add({ id: 2, action: 'type', risk: 'credential' });
    });
    const cards = [...host.querySelectorAll('.studio-approval')];
    const card2 = cards.find((c) => (c.textContent ?? '').includes('type'))!;
    clickIn(card2, '.studio-approval-approve');
    expect(JSON.parse(emit.mock.calls[0][0])).toEqual({ t: 'approval', id: 2, decision: 'approve' });
  });

  // PIN-A (no spurious approve). A card just sitting there — never actioned — must emit nothing.
  it('PIN-A: an un-actioned card emits no approval at all', () => {
    const model = new ApprovalsModel();
    const emit = vi.fn();
    mount(model, emit);
    act(() => model.add({ id: 1, action: 'click', risk: 'money' }));
    expect(emit).not.toHaveBeenCalled();
  });

  // PIN-B (server-authoritative risk/action). The card shows the message's risk + action VERBATIM — no client
  // re-derivation. NAMED mutation that REDs: derive/override risk on the client (e.g. map action→risk) → the
  // displayed risk no longer equals the host-sent value ('money', which no client rule would produce for a
  // generic click) and this assertion fails.
  it('PIN-B: displays the host-sent risk + action verbatim (no client re-derivation)', () => {
    const model = new ApprovalsModel();
    const host = mount(model, vi.fn());
    act(() => model.add({ id: 1, action: 'click', risk: 'money' }));
    const riskEl = host.querySelector('.studio-approval-risk');
    const actionEl = host.querySelector('.studio-approval-action');
    expect(riskEl?.textContent).toContain('money');
    expect(actionEl?.textContent).toContain('click');
  });

  // PIN-C (trust, SafeText). target.url/ref are host-relayed but may echo page-derived content, so they render
  // through SafeText as LITERAL text. NAMED mutation that REDs: render target.url via dangerouslySetInnerHTML
  // (bypass SafeText) → the markup parses, an <img> materializes and querySelector finds it.
  it('PIN-C: a target.url carrying markup renders as LITERAL text, parsing no element', () => {
    const model = new ApprovalsModel();
    const host = mount(model, vi.fn());
    const malicious = '<img src=x onerror="window.__pwned=1">';
    act(() => model.add({ id: 1, action: 'navigate', risk: 'destructive', target: { url: malicious } }));
    expect(host.querySelector('img')).toBeNull();
    expect(host.textContent).toContain(malicious);
  });

  // GUARDRAIL (inherited): capability language only — no dependency/implementation name in any user-facing
  // string OR visible attribute.
  it('GUARDRAIL: approval card copy uses capability language only — no dependency/implementation names', () => {
    const model = new ApprovalsModel();
    const host = mount(model, vi.fn());
    act(() => model.add({ id: 1, action: 'click', risk: 'money', target: { url: 'https://shop.test/buy' } }));
    let surface = (host.textContent ?? '').toLowerCase();
    for (const el of host.querySelectorAll('*')) {
      for (const attr of ['placeholder', 'aria-label', 'title', 'value', 'data-risk']) {
        surface += ' ' + (el.getAttribute(attr) ?? '').toLowerCase();
      }
    }
    const banned = ['preact', 'playwright', 'chromium', 'searxng', 'cdp', 'esbuild', 'sqlite', 'onnx', 'fastembed', 'websocket', 'jsdom'];
    for (const name of banned) {
      expect(surface, `approval card must not mention "${name}"`).not.toContain(name);
    }
  });
});
