import { randomUUID } from 'node:crypto';
import type { TabInfo } from '../shared/ipc';

export interface Rect { x: number; y: number; width: number; height: number }

/** The slice of WebContentsView the manager needs — real adapter in main/index.ts, fake in tests. */
export interface TabView {
  loadURL(url: string): Promise<void>;
  setBounds(b: Rect): void;
  setVisible(visible: boolean): void;
  destroy(): void;
  getURL(): string;
  getTitle(): string;
  onStateChange(cb: () => void): void;
}

export class TabManager {
  private tabs = new Map<string, TabView>();
  private order: string[] = [];
  private activeId: string | null = null;
  private listeners = new Set<() => void>();

  constructor(
    private makeView: () => TabView,
    private contentBounds: () => Rect,
  ) {}

  createTab(url: string): string {
    const id = randomUUID();
    const view = this.makeView();
    this.tabs.set(id, view);
    this.order.push(id);
    view.onStateChange(() => this.emit());
    view.setBounds(this.contentBounds());
    void view.loadURL(url);
    this.focusTab(id);
    return id;
  }

  focusTab(id: string): void {
    this.get(id);
    this.activeId = id;
    for (const [tid, view] of this.tabs) view.setVisible(tid === id);
    this.emit();
  }

  closeTab(id: string): void {
    const view = this.get(id);
    view.destroy();
    this.tabs.delete(id);
    this.order = this.order.filter((t) => t !== id);
    if (this.activeId === id) {
      this.activeId = this.order.at(-1) ?? null;
      if (this.activeId) this.focusTab(this.activeId);
    }
    this.emit();
  }

  navigate(id: string, url: string): void {
    void this.get(id).loadURL(url);
  }

  relayout(): void {
    const b = this.contentBounds();
    for (const view of this.tabs.values()) view.setBounds(b);
  }

  listTabs(): TabInfo[] {
    return this.order.map((id) => {
      const v = this.tabs.get(id)!;
      return { id, url: v.getURL(), title: v.getTitle(), active: id === this.activeId };
    });
  }

  viewOf(id: string): TabView {
    return this.get(id);
  }

  onChange(cb: () => void): void {
    this.listeners.add(cb);
  }

  private emit(): void {
    for (const cb of this.listeners) cb();
  }

  private get(id: string): TabView {
    const v = this.tabs.get(id);
    if (!v) throw new Error(`unknown tab: ${id}`);
    return v;
  }
}
