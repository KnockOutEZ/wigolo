import type { InputSink, KeyInput, AgentMouseInput, MouseButton } from 'wigolo/studio';
import type { CdpTransport } from './cdp-transport';

// The AGENT synthetic-input channel: dispatches balanced Input.* CDP events via
// the tab's webContents.debugger. Replaces the deleted v1 InputForwarder's agent
// path (the v1 human native-input forwarding is gone — the human touches the tab
// natively in the Electron model). Wrapped by the salvaged SessionController to
// yield the AgentInputChannel that act.ts requires. Tracks held button/key state
// so a control-flip (preemption) can release everything (neutralizeHeld).

type Viewport = () => { width: number; height: number };

function mouseParams(ev: AgentMouseInput): Record<string, unknown> {
  const p: Record<string, unknown> = { type: ev.type, x: ev.x, y: ev.y };
  if (ev.button !== undefined) p.button = ev.button;
  if (ev.buttons !== undefined) p.buttons = ev.buttons;
  if (ev.clickCount !== undefined) p.clickCount = ev.clickCount;
  if (ev.deltaX !== undefined) p.deltaX = ev.deltaX;
  if (ev.deltaY !== undefined) p.deltaY = ev.deltaY;
  if (ev.modifiers !== undefined) p.modifiers = ev.modifiers;
  return p;
}

function keyParams(ev: KeyInput): Record<string, unknown> {
  const p: Record<string, unknown> = { type: ev.type, key: ev.key };
  if (ev.code !== undefined) p.code = ev.code;
  if (ev.text !== undefined) p.text = ev.text;
  if (ev.modifiers !== undefined) p.modifiers = ev.modifiers;
  if (ev.windowsVirtualKeyCode !== undefined) p.windowsVirtualKeyCode = ev.windowsVirtualKeyCode;
  return p;
}

export function debuggerInputSink(transport: CdpTransport, viewport: Viewport): InputSink {
  const heldButtons = new Set<MouseButton>();
  const heldKeys = new Map<string, KeyInput>();

  const dispatchMouse = async (ev: AgentMouseInput): Promise<void> => {
    await transport.send('Input.dispatchMouseEvent', mouseParams(ev));
    if (ev.type === 'mousePressed' && ev.button && ev.button !== 'none') heldButtons.add(ev.button);
    if (ev.type === 'mouseReleased' && ev.button) heldButtons.delete(ev.button);
  };

  return {
    async key(ev: KeyInput): Promise<void> {
      await transport.send('Input.dispatchKeyEvent', keyParams(ev));
      if (ev.type === 'keyDown' || ev.type === 'rawKeyDown') heldKeys.set(ev.code ?? ev.key, ev);
      if (ev.type === 'keyUp') heldKeys.delete(ev.code ?? ev.key);
    },
    async agentMouseAt(ev: AgentMouseInput): Promise<void> {
      await dispatchMouse(ev);
    },
    async neutralizeHeld(): Promise<void> {
      for (const button of heldButtons) {
        await transport.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 0, y: 0, button });
      }
      heldButtons.clear();
      for (const held of heldKeys.values()) {
        await transport.send('Input.dispatchKeyEvent', { type: 'keyUp', key: held.key, ...(held.code ? { code: held.code } : {}) });
      }
      heldKeys.clear();
    },
    viewportCenter(): { x: number; y: number } {
      const { width, height } = viewport();
      return { x: Math.round(width / 2), y: Math.round(height / 2) };
    },
  };
}
