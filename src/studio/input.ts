import { createLogger } from '../logger.js';
import type { FrameMetadata } from './screencast.js';

/**
 * Forwards human input into the session page over CDP `Input.*`. Two things the
 * design hinges on:
 *  - Coordinate mapping uses the TRUE page CSS dimensions (`deviceWidth/Height`
 *    from the latest frame metadata), so a normalized click lands where the user
 *    clicked regardless of how far the screencast frame was downscaled (or the DPR).
 *  - Pressed-state bookkeeping: every held mouse button (with its last position)
 *    and held key is tracked, so on a control-token flip `neutralizeHeld()` can
 *    synthesize the matching releases — a flip mid-drag / mid-modifier must not
 *    strand a button or modifier down on the page.
 *
 * The control-token epoch gate (which input is allowed at all) lives at the hub;
 * this module only maps + dispatches + tracks. CDP session injected for tests.
 */

const log = createLogger('studio');

export interface InputCdp {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

export type MouseButton = 'none' | 'left' | 'middle' | 'right' | 'back' | 'forward';

export interface MouseInput {
  type: 'mousePressed' | 'mouseReleased' | 'mouseMoved' | 'mouseWheel';
  nx: number;
  ny: number;
  button?: MouseButton;
  buttons?: number;
  clickCount?: number;
  deltaX?: number;
  deltaY?: number;
  modifiers?: number;
}

export interface KeyInput {
  type: 'keyDown' | 'keyUp' | 'rawKeyDown' | 'char';
  key: string;
  code: string;
  text?: string;
  modifiers?: number;
  windowsVirtualKeyCode?: number;
}

export interface InputForwarderOptions {
  cdp: InputCdp;
  /** Fallback page CSS dimensions until the first frame metadata arrives (the configured screencast viewport). */
  viewport: { width: number; height: number };
}

export class InputForwarder {
  private cdp: InputCdp; // reassigned on rebind() after a crash recovery
  private readonly viewport: { width: number; height: number };
  private meta: FrameMetadata | null = null;
  private readonly pressedButtons = new Map<MouseButton, { x: number; y: number }>();
  private readonly pressedKeys = new Map<string, { key: string; code: string }>();

  constructor(o: InputForwarderOptions) {
    this.cdp = o.cdp;
    this.viewport = o.viewport;
  }

  /** Point input at a fresh CDP session after a crash recovery; the held-input state is cleared (the dead session's presses are gone). */
  rebind(cdp: InputCdp): void {
    this.cdp = cdp;
    this.pressedButtons.clear();
    this.pressedKeys.clear();
  }

  /** Record the latest frame metadata; mapping then uses its true page CSS dims, not the downscaled frame. */
  updateViewport(meta: FrameMetadata): void {
    this.meta = meta;
  }

  /** normalized [0,1] (relative to the displayed frame) → page CSS px — independent of frame downscale / DPR. Out-of-range is clamped into the viewport. */
  mapToPage(nx: number, ny: number): { x: number; y: number } {
    const width = this.meta?.deviceWidth ?? this.viewport.width;
    const height = this.meta?.deviceHeight ?? this.viewport.height;
    const clamp = (v: number) => Math.min(1, Math.max(0, v));
    return { x: clamp(nx) * width, y: clamp(ny) * height };
  }

  async mouse(ev: MouseInput): Promise<void> {
    // Drop non-finite coords at the input side rather than dispatch NaN/Infinity
    // into CDP (defense in depth — don't rely on the downstream rejecting them).
    if (!Number.isFinite(ev.nx) || !Number.isFinite(ev.ny)) {
      log.debug('dropping mouse input with non-finite coords', { nx: ev.nx, ny: ev.ny });
      return;
    }
    const { x, y } = this.mapToPage(ev.nx, ev.ny);
    await this.cdp.send('Input.dispatchMouseEvent', {
      type: ev.type,
      x,
      y,
      button: ev.button ?? 'none',
      buttons: ev.buttons,
      clickCount: ev.clickCount,
      deltaX: ev.deltaX,
      deltaY: ev.deltaY,
      modifiers: ev.modifiers,
    });
    this.trackMouse(ev, x, y);
  }

  async key(ev: KeyInput): Promise<void> {
    await this.cdp.send('Input.dispatchKeyEvent', {
      type: ev.type,
      key: ev.key,
      code: ev.code,
      text: ev.text,
      modifiers: ev.modifiers,
      windowsVirtualKeyCode: ev.windowsVirtualKeyCode,
    });
    this.trackKey(ev);
  }

  /**
   * Release everything the outgoing holder left pressed: a mouseReleased for each
   * held button (at its last tracked position) and a keyUp for each held key.
   * Called on every control-token flip before the new holder drives, so a flip
   * mid-drag / mid-modifier can't strand input on the page.
   */
  async neutralizeHeld(): Promise<void> {
    for (const [button, pos] of this.pressedButtons) {
      await this.cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: pos.x,
        y: pos.y,
        button,
        buttons: 0,
      });
    }
    for (const { key, code } of this.pressedKeys.values()) {
      await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code });
    }
    this.pressedButtons.clear();
    this.pressedKeys.clear();
  }

  private trackMouse(ev: MouseInput, x: number, y: number): void {
    const button = ev.button ?? 'none';
    if (ev.type === 'mousePressed' && button !== 'none') {
      this.pressedButtons.set(button, { x, y });
    } else if (ev.type === 'mouseReleased' && button !== 'none') {
      this.pressedButtons.delete(button);
    } else if (ev.type === 'mouseMoved' || ev.type === 'mouseWheel') {
      // Track the drag so a held button is released where it actually ended up.
      for (const held of this.pressedButtons.values()) {
        held.x = x;
        held.y = y;
      }
    }
  }

  private trackKey(ev: KeyInput): void {
    if (ev.type === 'keyDown' || ev.type === 'rawKeyDown') {
      this.pressedKeys.set(ev.code, { key: ev.key, code: ev.code });
    } else if (ev.type === 'keyUp') {
      this.pressedKeys.delete(ev.code);
    }
  }
}
