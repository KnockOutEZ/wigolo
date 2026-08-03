import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { studioBridgeFetch, studioBridgeAvailable } from '../../../src/fetch/studio-bridge.js';

/**
 * S9 slice 1 — the core-side bridge client.
 *
 * The rung is OPPORTUNISTIC by design. Everything here encodes one rule: a bridge that is absent, dead,
 * refusing, or returning nonsense must degrade to `null` so the caller keeps its honest challenge report.
 * A bridge fault must never become the user's error.
 */

let dir: string;

function publishHandle(): void {
  mkdirSync(join(dir, 'studio'), { recursive: true });
  writeFileSync(
    join(dir, 'studio', 'current.json'),
    JSON.stringify({ id: 's1', endpoint: 'http://127.0.0.1:1/mcp', token: 't', pid: 1, instanceId: 'other' }),
  );
}

function ok(body: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(body) }], isError: false };
}
function err(body: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(body) }], isError: true };
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'wig-bridge-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('studioBridgeAvailable — the live-session gate', () => {
  it('is false with no published handle, so a default install never pays for the rung', () => {
    expect(studioBridgeAvailable(dir)).toBe(false);
  });

  it('is true once a host publishes a handle', () => {
    publishHandle();
    expect(studioBridgeAvailable(dir)).toBe(true);
  });
});

describe('studioBridgeFetch', () => {
  it('does not call the transport at all when no session is published and none can be started', async () => {
    const call = vi.fn();
    const ensureRunning = vi.fn(async () => null);
    expect(await studioBridgeFetch('https://walled.example/', { dataDir: dir, call, ensureRunning })).toBeNull();
    expect(call).not.toHaveBeenCalled();
  });

  it('returns browser-tier bytes when the host serves the page', async () => {
    publishHandle();
    const call = vi.fn(async () => ok({ ok: true, url: 'https://walled.example/final', html: '<html>real content</html>', session_id: 's1' }));
    const r = await studioBridgeFetch('https://walled.example/', { dataDir: dir, call });
    expect(call).toHaveBeenCalledWith('studio_fetch', { url: 'https://walled.example/' });
    expect(r).toMatchObject({
      url: 'https://walled.example/',
      finalUrl: 'https://walled.example/final',
      html: '<html>real content</html>',
      statusCode: 200,
      method: 'browser',
      escalated: true,
    });
  });

  it('declines on a host refusal — the caller keeps its own blocked_by_challenge', async () => {
    publishHandle();
    const call = vi.fn(async () => err({ ok: false, error: 'capture_refused', error_reason: 'login page' }));
    expect(await studioBridgeFetch('https://walled.example/login', { dataDir: dir, call })).toBeNull();
  });

  it('declines when the transport throws — a dead host is never the user-visible error', async () => {
    publishHandle();
    const call = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    expect(await studioBridgeFetch('https://walled.example/', { dataDir: dir, call })).toBeNull();
  });

  it('declines on unparseable output rather than fabricating a page', async () => {
    publishHandle();
    const call = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'not json' }], isError: false }));
    expect(await studioBridgeFetch('https://walled.example/', { dataDir: dir, call })).toBeNull();
  });

  it('declines on an EMPTY body — "" is not a successful fetch, it is a blank tab', async () => {
    publishHandle();
    const call = vi.fn(async () => ok({ ok: true, url: 'https://walled.example/', html: '' }));
    expect(await studioBridgeFetch('https://walled.example/', { dataDir: dir, call })).toBeNull();
  });

  it('declines when ok is absent even though html is present — the success flag is the contract', async () => {
    publishHandle();
    const call = vi.fn(async () => ok({ url: 'https://walled.example/', html: '<html>x</html>' }));
    expect(await studioBridgeFetch('https://walled.example/', { dataDir: dir, call })).toBeNull();
  });
});

describe('studioBridgeFetch — amended-D4 auto-launch', () => {
  it('starts the substrate when none is running, then serves the page', async () => {
    // Starting a process is not a consent event: the session opens on a clean in-memory profile, and D9's
    // grant card is what gates spending the human's signed-in identity.
    const ensureRunning = vi.fn(async () => { publishHandle(); return { endpoint: 'x' }; });
    const call = vi.fn(async () => ok({ ok: true, url: 'https://walled.example/', html: '<html>after launch</html>' }));
    const r = await studioBridgeFetch('https://walled.example/', { dataDir: dir, call, ensureRunning });
    expect(ensureRunning).toHaveBeenCalledTimes(1);
    expect(r?.html).toBe('<html>after launch</html>');
  });

  it('does NOT try to launch when a session is already published', async () => {
    publishHandle();
    const ensureRunning = vi.fn(async () => null);
    const call = vi.fn(async () => ok({ ok: true, url: 'https://walled.example/', html: '<html>x</html>' }));
    await studioBridgeFetch('https://walled.example/', { dataDir: dir, call, ensureRunning });
    expect(ensureRunning).not.toHaveBeenCalled();
  });

  it('declines cleanly when the substrate cannot be started — no session, no error, no hang', async () => {
    const ensureRunning = vi.fn(async () => null);
    const call = vi.fn();
    expect(await studioBridgeFetch('https://walled.example/', { dataDir: dir, call, ensureRunning })).toBeNull();
    expect(call).not.toHaveBeenCalled();
  });
});
