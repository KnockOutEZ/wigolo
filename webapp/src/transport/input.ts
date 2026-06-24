import { up, type UpMessage } from './codec.js';

/**
 * Human input forwarding (S5): map a pointer/key event over the streamed canvas into the host's input wire
 * shape and emit it as `{t:'input'}`.
 *
 * The canvas displays a DOWNSCALED frame whose pixel size differs from the remote viewport, so coordinates
 * are sent NORMALIZED to [0,1] against the canvas rect — resolution-independent. The host maps normalized →
 * page CSS-px itself (InputForwarder.mapToPage), so the client never needs to know the remote viewport size.
 * Party is never sent: the WS is the authenticated human channel and the host stamps party='human'.
 */

export type MouseButtonName = 'none' | 'left' | 'middle' | 'right' | 'back' | 'forward';
export type MouseEventType = 'mousePressed' | 'mouseReleased' | 'mouseMoved' | 'mouseWheel';
export type KeyEventType = 'keyDown' | 'keyUp' | 'char';

export interface ClientRectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Map a canvas-relative client position to normalized [0,1] viewport coords (the host maps these → page px). */
export function toNormalized(clientX: number, clientY: number, rect: ClientRectLike): { nx: number; ny: number } {
  return {
    nx: clamp01((clientX - rect.left) / rect.width),
    ny: clamp01((clientY - rect.top) / rect.height),
  };
}

/** DOM MouseEvent.button → CDP button name. */
export function domButton(button: number): MouseButtonName {
  switch (button) {
    case 0:
      return 'left';
    case 1:
      return 'middle';
    case 2:
      return 'right';
    case 3:
      return 'back';
    case 4:
      return 'forward';
    default:
      return 'none';
  }
}

export interface MouseForward {
  type: MouseEventType;
  nx: number;
  ny: number;
  epoch: number;
  button?: MouseButtonName;
  buttons?: number;
  deltaX?: number;
  deltaY?: number;
  modifiers?: number;
}

/** Build the `{t:'input'}` up-message for a mouse event (kind:'mouse' + the host MouseInput fields). */
export function mouseInput(i: MouseForward): UpMessage {
  return up.input({ kind: 'mouse', ...i });
}

export interface KeyForward {
  type: KeyEventType;
  key: string;
  epoch: number;
  code?: string;
  text?: string;
  modifiers?: number;
}

/** Build the `{t:'input'}` up-message for a key event (kind:'key' + the host KeyInput fields). */
export function keyInput(i: KeyForward): UpMessage {
  return up.input({ kind: 'key', ...i });
}

/** CDP modifier bitmask (Alt=1, Ctrl=2, Meta/Cmd=4, Shift=8). */
export function modifiersOf(ev: { altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }): number {
  return (ev.altKey ? 1 : 0) | (ev.ctrlKey ? 2 : 0) | (ev.metaKey ? 4 : 0) | (ev.shiftKey ? 8 : 0);
}
