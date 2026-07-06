import { describe, it, expect, vi } from 'vitest';
import { registerMarksIpc, type MarksIpcDeps } from '../../src/main/ipc-host';
import { IPC } from '../../src/shared/ipc';

/** A fake ipcMain that records .on/.handle callbacks so the test can fire them with a synthetic event. */
type IpcEvent = { sender: unknown };
function fakeIpc() {
  const on = new Map<string, (e: IpcEvent, ...a: unknown[]) => unknown>();
  const handle = new Map<string, (e: IpcEvent, ...a: unknown[]) => unknown>();
  return {
    ipcMain: {
      on: (ch: string, cb: (e: IpcEvent, ...a: unknown[]) => void) => { on.set(ch, cb); },
      handle: (ch: string, cb: (e: IpcEvent, ...a: unknown[]) => unknown) => { handle.set(ch, cb); },
    },
    fireOn: (ch: string, e: IpcEvent, ...a: unknown[]) => on.get(ch)?.(e, ...a),
    invoke: (ch: string, e: IpcEvent, ...a: unknown[]) => handle.get(ch)?.(e, ...a),
  };
}

function setup(over: Partial<MarksIpcDeps> = {}) {
  const f = fakeIpc();
  const markElement = vi.fn(async () => ({ markId: 'm1', role: 'button', name: 'Buy' }));
  const addComment = vi.fn(async () => ({ ok: true as const }));
  const captureQuote = vi.fn(async () => ({ artifact_id: 1, inserted: true, content_hash: 'h' }));
  const marks = vi.fn(async () => ({ markId: 'm1', refs: ['e1', 'e2', 'e3'], confidence: 'high' as const, requires_confirmation: true as const }));
  const sendToTab = vi.fn();
  const sendToRenderer = vi.fn();
  const broadcastMarks = vi.fn(async () => {});
  const sender = { id: 'wc-1' };
  const deps: MarksIpcDeps = {
    ipcMain: f.ipcMain,
    host: { markElement, addComment, captureQuote, handlers: { marks } } as unknown as MarksIpcDeps['host'],
    resolveTab: (s) => (s === sender ? 't1' : undefined),
    sendToTab,
    sendToRenderer,
    broadcastMarks,
    focusedSessionTab: () => 't1',
    ...over,
  };
  registerMarksIpc(deps);
  return { f, deps, markElement, addComment, captureQuote, marks, sendToTab, sendToRenderer, broadcastMarks, sender };
}

describe('registerMarksIpc — overlay↔main↔renderer marks routing', () => {
  it('overlayMark: sender→tabId→host.markElement, echoes the assigned chip number, refreshes the rail', async () => {
    const t = setup();
    await t.f.fireOn(IPC.overlayMark, { sender: t.sender }, { nonce: 'n1', path: [0, 0], payload: { tag: 'button' } });
    expect(t.markElement).toHaveBeenCalledWith({ tabId: 't1', path: [0, 0], payload: { tag: 'button' } });
    expect(t.sendToTab).toHaveBeenCalledWith('t1', IPC.overlayMarkAssigned, { nonce: 'n1', markId: 'm1', number: 1 });
    expect(t.broadcastMarks).toHaveBeenCalled();
  });

  it('overlayMark from an UNKNOWN sender (no session tab) does not mark', async () => {
    const t = setup();
    await t.f.fireOn(IPC.overlayMark, { sender: { id: 'stranger' } }, { nonce: 'n1', path: [0, 0], payload: {} });
    expect(t.markElement).not.toHaveBeenCalled();
  });

  it('markComment (invoke) → host.addComment + rail refresh, returns ok', async () => {
    const t = setup();
    const r = await t.f.invoke(IPC.markComment, { sender: t.sender }, 'm1', 'the CTA');
    expect(t.addComment).toHaveBeenCalledWith({ markId: 'm1', text: 'the CTA' });
    expect(t.broadcastMarks).toHaveBeenCalled();
    expect(r).toEqual({ ok: true });
  });

  it('markGeneralize (invoke) returns the confirm-gated preview from the host', async () => {
    const t = setup();
    const r = await t.f.invoke(IPC.markGeneralize, { sender: t.sender }, 'm1');
    expect(t.marks).toHaveBeenCalledWith({ op: 'generalize', markId: 'm1' });
    expect(r).toMatchObject({ refs: ['e1', 'e2', 'e3'], requires_confirmation: true });
  });

  it('overlayGeneralize (from the tab action bar) pushes the preview to the renderer', async () => {
    const t = setup();
    await t.f.fireOn(IPC.overlayGeneralize, { sender: t.sender }, { markId: 'm1' });
    expect(t.marks).toHaveBeenCalledWith({ op: 'generalize', markId: 'm1' });
    expect(t.sendToRenderer).toHaveBeenCalledWith(IPC.generalizePreview, expect.objectContaining({ requires_confirmation: true }));
  });

  it('overlayQuote: sender→tabId→host.captureQuote (host applies the credential gate)', async () => {
    const t = setup();
    const quote = { text: 'a quote', url: 'https://ex.com/a', context: 'the surrounding paragraph' };
    await t.f.fireOn(IPC.overlayQuote, { sender: t.sender }, quote);
    expect(t.captureQuote).toHaveBeenCalledWith('t1', quote);
  });

  it('overlayQuote from an UNKNOWN sender (no session tab) does not capture', async () => {
    const t = setup();
    await t.f.fireOn(IPC.overlayQuote, { sender: { id: 'stranger' } }, { text: 'q', url: 'u', context: 'c' });
    expect(t.captureQuote).not.toHaveBeenCalled();
  });

  it('armMarkMode arms the focused session tab overlay', async () => {
    const t = setup();
    await t.f.fireOn(IPC.armMarkMode, { sender: t.sender });
    expect(t.sendToTab).toHaveBeenCalledWith('t1', IPC.overlayArm, undefined);
  });
});
