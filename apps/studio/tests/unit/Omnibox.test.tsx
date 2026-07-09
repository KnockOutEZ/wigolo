// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { Toolbar } from '../../src/renderer/Omnibox';

// React 19 act() needs this flag set for the test environment.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const baseProps = {
  onNavigate: vi.fn(),
  onBack: vi.fn(),
  onForward: vi.fn(),
  onReload: vi.fn(),
  railOpen: true,
  onToggleRail: vi.fn(),
  onClip: vi.fn(),
  onIntent: vi.fn(),
};

let container: HTMLDivElement;
let root: Root;

function mount(props: Partial<typeof baseProps> & { currentUrl: string }) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { root.render(<Toolbar {...baseProps} {...props} />); });
}

function input(): HTMLInputElement {
  return container.querySelector('[data-testid="omnibox"]') as HTMLInputElement;
}

function type(value: string) {
  const el = input();
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function key(k: string): boolean {
  const el = input();
  const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
  act(() => { el.dispatchEvent(ev); });
  return ev.defaultPrevented;
}

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { act(() => root.unmount()); container.remove(); });

describe('Toolbar omnibox — dual-mode intent (P6 F2)', () => {
  it('lead glyph reflects what the box will DO: nav for a URL, search for a query', () => {
    mount({ currentUrl: 'https://x.test' });
    expect(input().parentElement!.querySelector('.omnibox__lead')!.getAttribute('data-hint')).toBe('nav');
    type('best pricing tools');
    expect(input().parentElement!.querySelector('.omnibox__lead')!.getAttribute('data-hint')).toBe('search');
  });

  it('⇥ hands free text to the agent as intent — never navigates — and restores the url', () => {
    mount({ currentUrl: 'https://x.test' });
    type('summarize the pricing on this page');
    const prevented = key('Tab');
    expect(prevented).toBe(true);
    expect(baseProps.onIntent).toHaveBeenCalledWith('summarize the pricing on this page');
    expect(baseProps.onNavigate).not.toHaveBeenCalled();
    expect(input().value).toBe('https://x.test'); // restored
  });

  it('Enter is unchanged: a URL navigates, a query searches (regression pin)', () => {
    mount({ currentUrl: '' });
    type('example.com');
    key('Enter');
    expect(baseProps.onNavigate).toHaveBeenCalledWith('https://example.com');
    expect(baseProps.onIntent).not.toHaveBeenCalled();

    vi.clearAllMocks();
    type('best pricing tools');
    key('Enter');
    expect(baseProps.onNavigate).toHaveBeenCalledWith('https://duckduckgo.com/?q=best%20pricing%20tools');
  });

  it('NEGATIVE: ⇥ with no onIntent wired does not navigate + does not crash', () => {
    mount({ currentUrl: 'https://x.test', onIntent: undefined });
    type('some intent text');
    key('Tab');
    expect(baseProps.onNavigate).not.toHaveBeenCalled();
  });
});
