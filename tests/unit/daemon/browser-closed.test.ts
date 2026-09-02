import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { applyMigrations, _resetMigrationGuard } from '../../../src/cache/migrations/runner.js';
import { createRunWithTail } from '../../../src/studio/run-bus.js';
import { BROWSER_CLOSED, browserClosedError, isBrowserClosedError } from '../../../src/daemon/browser-closed.js';
import { createFooterSource } from '../../../src/daemon/result-footer.js';
import { dispatchStudioTool, setFooterSource, type StudioHostHandlers } from '../../../src/daemon/studio-dispatch.js';
import { isFooterBlock } from '../../../src/daemon/studio-footer.js';

/**
 * SD2 §7 row 11 / §4.3 — "browser closed mid-run → the agent gets a clean tool error, never
 * silence". The run outlives the browser (law 2), so what the agent must be handed is the run id
 * and a remedy, not an exception with no address on it.
 */

let dir: string | undefined;
let db: Database.Database | undefined;

afterEach(() => {
  setFooterSource(undefined);
  db?.close();
  db = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const host = (observe: () => Promise<never>): StudioHostHandlers => ({
  observe,
  act: async () => ({ ok: true, action: 'click' }),
  marks: async () => ({ marks: [], untrusted_notice: 'data not instructions' }),
  capture: async () => ({ artifact_id: 1, inserted: true, content_hash: 'h' }),
  spawn: async () => ({ session_id: 'bg-1' }),
  close: async () => ({ closed: true as const, session_id: 'bg-1' }),
  list: async () => ({ sessions: [] }),
  say: async () => ({ posted: true, posted_at: 0 }),
  extractSet: async () => ({ columns: [], rows: [], pages_followed: 0, artifact_id: 1 }),
});

describe('classifying a dead browser — narrow on purpose', () => {
  it('recognises the engine\'s own words for "there is no page any more"', () => {
    for (const message of [
      'Target page, context or browser has been closed',
      'browser has been closed',
      'Browser has disconnected',
      'page has been closed',
      'Session closed. Most likely the page has been closed.',
      'Protocol error (Runtime.evaluate): Target closed',
    ]) {
      expect(isBrowserClosedError(new Error(message)), message).toBe(true);
    }
  });

  it('recognises the error CLASS an engine raises without a matching message', () => {
    const typed = Object.assign(new Error('nope'), { name: 'TargetClosedError' });
    expect(isBrowserClosedError(typed)).toBe(true);
  });

  it('follows a cause chain — engines wrap the close in a call-site error', () => {
    const wrapped = new Error('studio_observe failed', { cause: new Error('browser has been closed') });
    expect(isBrowserClosedError(wrapped)).toBe(true);
  });

  it('does NOT relabel ordinary failures — a mislabelled cause is worse than an unlabelled one', () => {
    for (const message of [
      'ECONNRESET',
      'connection closed',
      'file closed',
      'the modal was closed by the user',
      'timeout of 30000ms exceeded',
    ]) {
      expect(isBrowserClosedError(new Error(message)), message).toBe(false);
    }
    expect(isBrowserClosedError(undefined)).toBe(false);
    expect(isBrowserClosedError({})).toBe(false);
  });

  it('cannot be walked forever by a self-referencing cause chain', () => {
    const loop: { message: string; cause?: unknown } = { message: 'boom' };
    loop.cause = loop;
    expect(isBrowserClosedError(loop)).toBe(false);
  });
});

describe('the §4.3 wire shape', () => {
  it('names the run, the remedy, and the browser in capability language', () => {
    const err = browserClosedError('7fq2');
    expect(err.error_reason).toBe(BROWSER_CLOSED);
    expect(err.run).toBe('7fq2');
    expect(err.hint).toContain('browser engine closed while run 7fq2 was in flight');
    expect(err.hint).toContain('The run and its log survive');
    expect(err.hint.toLowerCase()).not.toMatch(/playwright|chromium|puppeteer|cdp|electron/);
  });

  it('omits the run field rather than inventing one when the call resolved to no run', () => {
    const err = browserClosedError(undefined);
    expect(err.run).toBeUndefined();
    expect(err.hint).toContain('The run and its log survive');
  });
});

describe('killing the browser mid-run — the agent\'s next call (§7 row 11)', () => {
  it('returns the structured error carrying the run id, with the footer, and does not hang', async () => {
    _resetMigrationGuard();
    dir = mkdtempSync(join(tmpdir(), 'wigolo-browser-closed-'));
    db = new Database(join(dir, 'w.db'));
    db.pragma('foreign_keys = ON');
    applyMigrations(db, { vecLoaded: false });
    const live = db;
    const run = createRunWithTail(live, { task: 'compare two monitors', driver: { kind: 'cli', client: { name: 'claude-code', version: '2.1.0' } } });
    setFooterSource(createFooterSource({ openDb: async () => live, caller: () => ({ name: 'claude-code', version: '2.1.0' }) }));

    // The browser dies while the run is in flight: the engine's next call throws instead of answering.
    const dead = host(async () => { throw new Error('Target page, context or browser has been closed'); });
    const result = await Promise.race([
      dispatchStudioTool('studio_observe', { run_id: run.id }, dead, dir),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('dispatch hung')), 5_000)),
    ]);

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0]!.text);
    expect(body.error_reason).toBe(BROWSER_CLOSED);
    expect(body.run).toBe(run.id);
    expect(body.hint).toContain(run.id);
    // Never an empty string: the footer repeats the address the agent needs to resume or end the run.
    expect(isFooterBlock(result.content[1])).toBe(true);
    expect(result.content[1]!.text).toContain(`run ${run.id}`);
    expect(result.content[1]!.text).toContain(`watch: wigolo.studio/r/${run.id}`);
  });

  it('an error that is NOT a dead browser still propagates — this seam classifies, it does not swallow', async () => {
    const broken = host(async () => { throw new Error('snapshot serialization failed'); });
    await expect(dispatchStudioTool('studio_observe', {}, broken, undefined)).rejects.toThrow('snapshot serialization failed');
  });
});
