import { describe, it, expect, vi } from 'vitest';
import { TabManager, type TabView } from '../../src/main/tab-manager';

function fakeView(): TabView {
  return {
    loadURL: vi.fn(async () => {}),
    setBounds: vi.fn(),
    setVisible: vi.fn(),
    destroy: vi.fn(),
    getURL: () => 'about:blank',
    getTitle: () => 'blank',
    onStateChange: vi.fn(),
  };
}

describe('TabManager', () => {
  const bounds = { x: 0, y: 88, width: 1280, height: 752 };

  it('creates a tab, makes it active, and lays it out below the chrome header', () => {
    const tm = new TabManager(fakeView, () => bounds);
    const id = tm.createTab('https://example.com');
    const tab = tm.listTabs().find((t) => t.id === id)!;
    expect(tab.active).toBe(true);
    expect(tm.viewOf(id).setBounds).toHaveBeenCalledWith(bounds);
    expect(tm.viewOf(id).loadURL).toHaveBeenCalledWith('https://example.com');
  });

  it('focusing tab B hides A and shows B — exactly one visible tab (single-driver surface)', () => {
    const tm = new TabManager(fakeView, () => bounds);
    const a = tm.createTab('https://a.test');
    const b = tm.createTab('https://b.test');
    tm.focusTab(a);
    expect(tm.viewOf(b).setVisible).toHaveBeenLastCalledWith(false);
    expect(tm.viewOf(a).setVisible).toHaveBeenLastCalledWith(true);
    expect(tm.listTabs().filter((t) => t.active)).toHaveLength(1);
  });

  it('closing the active tab activates a neighbor and destroys the view (no leaked WebContents)', () => {
    const tm = new TabManager(fakeView, () => bounds);
    const a = tm.createTab('https://a.test');
    const b = tm.createTab('https://b.test');
    const bView = tm.viewOf(b);
    tm.closeTab(b);
    expect(bView.destroy).toHaveBeenCalled();
    expect(tm.listTabs().map((t) => t.id)).toEqual([a]);
    expect(tm.listTabs()[0].active).toBe(true);
  });

  it('closing an unknown tab throws (fail loud)', () => {
    const tm = new TabManager(fakeView, () => bounds);
    expect(() => tm.closeTab('nope')).toThrow(/unknown tab/i);
  });
});
