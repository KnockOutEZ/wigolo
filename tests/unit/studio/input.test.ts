import { describe, it, expect } from 'vitest';
import { InputForwarder } from '../../../src/studio/input.js';

function makeFakeInputCdp() {
  const sends: Array<{ method: string; params: Record<string, unknown> }> = [];
  return {
    cdp: {
      send: async (method: string, params?: Record<string, unknown>) => {
        sends.push({ method, params: params ?? {} });
        return {};
      },
    },
    sends,
  };
}

describe('InputForwarder — coordinate mapping (landmine #3)', () => {
  it('maps normalized coords to TRUE page CSS px from frame metadata, NOT the downscaled frame', async () => {
    const f = makeFakeInputCdp();
    const fwd = new InputForwarder({ cdp: f.cdp, viewport: { width: 1280, height: 720 } });
    // Page is 1920x1080 CSS px but the screencast frame is downscaled (e.g. 1280x720).
    fwd.updateViewport({ deviceWidth: 1920, deviceHeight: 1080, pageScaleFactor: 1 });
    await fwd.mouse({ type: 'mousePressed', nx: 0.5, ny: 0.5, button: 'left' });
    const press = f.sends.find((s) => s.method === 'Input.dispatchMouseEvent');
    // 0.5 * TRUE 1920/1080 = 960/540 — NOT the downscaled frame's 640/360.
    expect(press?.params).toMatchObject({ x: 960, y: 540 });
  });

  it('falls back to the configured viewport before any frame metadata has arrived', async () => {
    const f = makeFakeInputCdp();
    const fwd = new InputForwarder({ cdp: f.cdp, viewport: { width: 1280, height: 720 } });
    await fwd.mouse({ type: 'mousePressed', nx: 0.5, ny: 0.5, button: 'left' });
    expect(f.sends[0]?.params).toMatchObject({ x: 640, y: 360 });
  });
});

describe('InputForwarder — dispatch', () => {
  it('forwards a mouse event via CDP Input.dispatchMouseEvent', async () => {
    const f = makeFakeInputCdp();
    const fwd = new InputForwarder({ cdp: f.cdp, viewport: { width: 1000, height: 1000 } });
    await fwd.mouse({ type: 'mouseMoved', nx: 0.1, ny: 0.2 });
    expect(f.sends[0]).toMatchObject({ method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x: 100, y: 200 } });
  });

  it('forwards a key event via CDP Input.dispatchKeyEvent', async () => {
    const f = makeFakeInputCdp();
    const fwd = new InputForwarder({ cdp: f.cdp, viewport: { width: 1000, height: 1000 } });
    await fwd.key({ type: 'keyDown', key: 'a', code: 'KeyA', text: 'a' });
    expect(f.sends[0]).toMatchObject({ method: 'Input.dispatchKeyEvent', params: { type: 'keyDown', key: 'a', code: 'KeyA', text: 'a' } });
  });

  it('rebind(cdp) routes subsequent input to the new session (crash recovery)', async () => {
    const dead = makeFakeInputCdp();
    const fresh = makeFakeInputCdp();
    const fwd = new InputForwarder({ cdp: dead.cdp, viewport: { width: 1000, height: 1000 } });
    fwd.rebind(fresh.cdp);
    await fwd.mouse({ type: 'mouseMoved', nx: 0.1, ny: 0.1 });
    expect(dead.sends).toHaveLength(0);
    expect(fresh.sends).toHaveLength(1);
  });

  it('drops a mouse event with non-finite coords instead of dispatching NaN/Infinity', async () => {
    const f = makeFakeInputCdp();
    const fwd = new InputForwarder({ cdp: f.cdp, viewport: { width: 1000, height: 1000 } });
    await fwd.mouse({ type: 'mouseMoved', nx: Number.POSITIVE_INFINITY, ny: 0.5 });
    await fwd.mouse({ type: 'mousePressed', nx: Number.NaN, ny: 0.5, button: 'left' });
    expect(f.sends).toHaveLength(0);
  });

  it('clamps out-of-range normalized coords into the viewport', async () => {
    const f = makeFakeInputCdp();
    const fwd = new InputForwarder({ cdp: f.cdp, viewport: { width: 1000, height: 1000 } });
    await fwd.mouse({ type: 'mouseMoved', nx: 1.5, ny: -0.2 });
    expect(f.sends[0]?.params).toMatchObject({ x: 1000, y: 0 }); // clamped to [0,1] → edges
  });
});

describe('InputForwarder — held-input neutralization (landmine #2)', () => {
  it('releases a held mouse button AND a held modifier on a flip, at the last drag position; second call is a no-op', async () => {
    const f = makeFakeInputCdp();
    const fwd = new InputForwarder({ cdp: f.cdp, viewport: { width: 1280, height: 720 } });

    // Mid-drag with Shift held: press LMB, hold Shift, drag.
    await fwd.mouse({ type: 'mousePressed', nx: 0.5, ny: 0.5, button: 'left' });
    await fwd.key({ type: 'keyDown', key: 'Shift', code: 'ShiftLeft' });
    await fwd.mouse({ type: 'mouseMoved', nx: 0.6, ny: 0.6, button: 'left', buttons: 1 });

    f.sends.length = 0; // only inspect what neutralize synthesizes
    await fwd.neutralizeHeld();

    const released = f.sends.filter((s) => s.method === 'Input.dispatchMouseEvent' && s.params.type === 'mouseReleased');
    const keyUps = f.sends.filter((s) => s.method === 'Input.dispatchKeyEvent' && s.params.type === 'keyUp');
    expect(released).toHaveLength(1); // the stranded LMB is released
    expect(released[0].params).toMatchObject({ x: 768, y: 432, button: 'left' }); // at the LAST drag position (0.6 * 1280/720)
    expect(keyUps.some((s) => s.params.code === 'ShiftLeft')).toBe(true); // the stranded modifier is released

    f.sends.length = 0;
    await fwd.neutralizeHeld(); // nothing held now
    expect(f.sends).toHaveLength(0);
  });

  it('stops tracking a button/key once it is released normally (no double-release on neutralize)', async () => {
    const f = makeFakeInputCdp();
    const fwd = new InputForwarder({ cdp: f.cdp, viewport: { width: 1000, height: 1000 } });
    await fwd.mouse({ type: 'mousePressed', nx: 0.5, ny: 0.5, button: 'left' });
    await fwd.mouse({ type: 'mouseReleased', nx: 0.5, ny: 0.5, button: 'left' });
    await fwd.key({ type: 'keyDown', key: 'a', code: 'KeyA' });
    await fwd.key({ type: 'keyUp', key: 'a', code: 'KeyA' });
    f.sends.length = 0;
    await fwd.neutralizeHeld();
    expect(f.sends).toHaveLength(0); // nothing left held
  });
});
