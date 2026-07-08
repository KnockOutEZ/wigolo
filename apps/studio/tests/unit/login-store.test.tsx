import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createLoginStore } from '../../src/renderer/login-store';
import { LoginCard } from '../../src/renderer/LoginCard';

describe('login-store', () => {
  it('holds the in_progress state with origin', () => {
    const s = createLoginStore();
    s.apply({ state: 'in_progress', origin: 'https://example.com' });
    expect(s.current()).toEqual({ state: 'in_progress', origin: 'https://example.com' });
  });
  it('holds completed after a settle', () => {
    const s = createLoginStore();
    s.apply({ state: 'in_progress', origin: 'https://x.io' });
    s.apply({ state: 'completed', origin: 'https://x.io' });
    expect(s.current()?.state).toBe('completed');
  });
  it('holds failed', () => {
    const s = createLoginStore();
    s.apply({ state: 'failed', origin: 'https://x.io' });
    expect(s.current()?.state).toBe('failed');
  });
  it('reset() clears (per-session switch)', () => {
    const s = createLoginStore();
    s.apply({ state: 'in_progress' });
    s.reset();
    expect(s.current()).toBeNull();
  });
  it('notifies subscribers on change; unsubscribe stops them', () => {
    const s = createLoginStore();
    const seen: unknown[] = [];
    const off = s.subscribe(() => seen.push(s.current()));
    s.apply({ state: 'in_progress' });
    off();
    s.apply({ state: 'completed' });
    expect(seen).toHaveLength(1);
  });
});

describe('LoginCard capability language + honest copy', () => {
  const impl = /playwright|electron|chromium|cdp|webcontents|debugger/i;
  it('renders nothing when there is no active handoff', () => {
    expect(renderToStaticMarkup(<LoginCard login={null} />)).toBe('');
  });
  for (const state of ['in_progress', 'completed', 'failed'] as const) {
    it(`${state} card renders, tells the human what to do, and leaks no implementation names`, () => {
      const html = renderToStaticMarkup(<LoginCard login={{ state, origin: 'https://example.com' }} />);
      expect(html).not.toMatch(impl);
      expect(html.length).toBeGreaterThan(0);
      if (state === 'in_progress') expect(html.toLowerCase()).toContain('cannot see your credentials');
      if (state === 'completed') {
        // D-P5-7 honest copy: NO persistence claim (keychain-less hosts fail-close, nothing stored).
        expect(html.toLowerCase()).not.toMatch(/saved securely|stored securely|saved for/);
      }
    });
  }
});
