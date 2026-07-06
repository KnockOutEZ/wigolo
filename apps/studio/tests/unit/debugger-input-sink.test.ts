import { describe, it, expect, vi } from 'vitest';
import { debuggerInputSink } from '../../src/main/debugger-input-sink';
import type { CdpTransport } from '../../src/main/cdp-transport';

function fakeTransport(): CdpTransport & { sends: Array<{ method: string; params?: Record<string, unknown> }> } {
  const sends: Array<{ method: string; params?: Record<string, unknown> }> = [];
  return {
    sends,
    send: vi.fn(async (method: string, params?: Record<string, unknown>) => {
      sends.push({ method, params });
      return {};
    }),
    on: vi.fn(),
    off: vi.fn(),
    attach: vi.fn(),
    detach: vi.fn(),
  };
}

describe('debuggerInputSink (agent synthetic input over CDP Input.*)', () => {
  it('agentMouseAt dispatches Input.dispatchMouseEvent at the resolver page-px coords', async () => {
    const t = fakeTransport();
    const sink = debuggerInputSink(t, () => ({ width: 1000, height: 800 }));
    await sink.agentMouseAt({ type: 'mousePressed', x: 42, y: 99, button: 'left', clickCount: 1 });
    expect(t.sends.at(-1)).toMatchObject({
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mousePressed', x: 42, y: 99, button: 'left', clickCount: 1 },
    });
  });

  it('key dispatches Input.dispatchKeyEvent', async () => {
    const t = fakeTransport();
    const sink = debuggerInputSink(t, () => ({ width: 1000, height: 800 }));
    await sink.key({ type: 'char', key: 'a', text: 'a' });
    expect(t.sends.at(-1)).toMatchObject({ method: 'Input.dispatchKeyEvent', params: { type: 'char', text: 'a' } });
  });

  it('neutralizeHeld releases a held mouse button and a held key (control-flip safety)', async () => {
    const t = fakeTransport();
    const sink = debuggerInputSink(t, () => ({ width: 1000, height: 800 }));
    await sink.agentMouseAt({ type: 'mousePressed', x: 10, y: 10, button: 'left' });
    await sink.key({ type: 'keyDown', key: 'Shift', code: 'ShiftLeft' });
    t.sends.length = 0;
    await sink.neutralizeHeld();
    const types = t.sends.map((s) => `${s.method}:${(s.params as { type?: string })?.type}`);
    expect(types).toContain('Input.dispatchMouseEvent:mouseReleased');
    expect(types).toContain('Input.dispatchKeyEvent:keyUp');
  });

  it('neutralizeHeld with nothing held is a no-op', async () => {
    const t = fakeTransport();
    const sink = debuggerInputSink(t, () => ({ width: 1000, height: 800 }));
    await sink.neutralizeHeld();
    expect(t.sends).toHaveLength(0);
  });

  it('viewportCenter returns the centre of the injected viewport (agent scroll aim)', () => {
    const t = fakeTransport();
    const sink = debuggerInputSink(t, () => ({ width: 1000, height: 800 }));
    expect(sink.viewportCenter()).toEqual({ x: 500, y: 400 });
  });
});
