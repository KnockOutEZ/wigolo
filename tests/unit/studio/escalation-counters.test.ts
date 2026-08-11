import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync, writeFileSync, mkdirSync, readFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bumpEscalationCounter,
  readEscalationCounters,
  formatEscalationCounterLines,
} from '../../../src/studio/escalation-counters.js';

/**
 * S9 / D10(a) — the local escalation-rate counters.
 *
 * D9's budget default shipped as an admitted placeholder. These counters are the only reason it can be
 * replaced by a real number later instead of another argument, so the tests hold them to being (a) durable,
 * (b) never load-bearing, and (c) local — no origins, no timestamps, nothing that leaves the machine.
 */

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'wig-esc-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('escalation counters', () => {
  it('start at zero with no file on disk', () => {
    expect(readEscalationCounters(dir)).toMatchObject({ bridgeAttempted: 0, budgetRefused: 0, cardShown: 0 });
  });

  it('accumulate across calls and persist', () => {
    bumpEscalationCounter('bridgeAttempted', dir);
    bumpEscalationCounter('bridgeAttempted', dir);
    bumpEscalationCounter('bridgeServed', dir);
    const c = readEscalationCounters(dir);
    expect(c.bridgeAttempted).toBe(2);
    expect(c.bridgeServed).toBe(1);
    expect(c.bridgeDeclined).toBe(0);
  });

  it('are written 0600 like the rest of the studio data dir', () => {
    bumpEscalationCounter('cardShown', dir);
    // POSIX mode-bit assert (0o600) — skip on win32 (no POSIX perms) to match existing test patterns.
    if (process.platform !== 'win32') {
      expect(statSync(join(dir, 'studio', 'escalation-counters.json')).mode & 0o777).toBe(0o600);
    }
  });

  it('a corrupt file resets to zero instead of throwing — instrumentation is never load-bearing', () => {
    mkdirSync(join(dir, 'studio'), { recursive: true });
    writeFileSync(join(dir, 'studio', 'escalation-counters.json'), '{{{not json');
    expect(readEscalationCounters(dir).bridgeAttempted).toBe(0);
    expect(() => bumpEscalationCounter('bridgeAttempted', dir)).not.toThrow();
    expect(readEscalationCounters(dir).bridgeAttempted).toBe(1);
  });

  it('an unwritable data dir does not throw — a counter must never fail a fetch', () => {
    // Use a real directory with the write bit cleared. Do NOT reach for a /proc path here:
    // `mkdirSync(…, { recursive: true })` under procfs NEVER RETURNS on Linux — it spins at
    // 100% CPU inside a SYNCHRONOUS call, so no test timeout can interrupt it, the vitest
    // worker never exits, and the entire run hangs until CI's job bound kills it. This exact
    // line (previously '/proc/definitely/not/writable') is what wedged
    // `lint + build + unit (ubuntu-latest)` at its 25-minute cap, while the macOS and Windows
    // legs of the SAME commit passed in ~5 minutes: /proc exists only on Linux, so everywhere
    // else the path failed fast with ENOENT and the landmine stayed invisible.
    const locked = mkdtempSync(join(tmpdir(), 'wig-esc-ro-'));
    chmodSync(locked, 0o500);
    try {
      expect(() => bumpEscalationCounter('bridgeServed', locked)).not.toThrow();
      // Non-vacuous wherever mode bits are actually enforced: prove the write was refused,
      // rather than the counter quietly succeeding and `not.toThrow()` passing for free.
      // win32 has no POSIX perms, and root bypasses them outright (containers often run as
      // root, so this is not hypothetical) — in both cases the write legitimately succeeds
      // and only the no-throw contract above is under test.
      const modeBitsEnforced = process.platform !== 'win32' && process.getuid?.() !== 0;
      if (modeBitsEnforced) {
        expect(existsSync(join(locked, 'studio', 'escalation-counters.json'))).toBe(false);
      }
    } finally {
      chmodSync(locked, 0o700);
      rmSync(locked, { recursive: true, force: true });
    }
  });

  it('ignores negative or non-numeric values already on disk', () => {
    mkdirSync(join(dir, 'studio'), { recursive: true });
    writeFileSync(join(dir, 'studio', 'escalation-counters.json'), JSON.stringify({ v: 1, bridgeServed: -4, cardShown: 'lots' }));
    const c = readEscalationCounters(dir);
    expect(c.bridgeServed).toBe(0);
    expect(c.cardShown).toBe(0);
  });

  it('stores NO origin, url or timestamp — a per-origin history would be browsing history', () => {
    bumpEscalationCounter('cardApproved', dir);
    const raw = readFileSync(join(dir, 'studio', 'escalation-counters.json'), 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const [k, v] of Object.entries(parsed)) {
      if (k === 'v') continue;
      expect(typeof v).toBe('number');
    }
  });

  it('the module contains no network code at all — local only, no phone-home', () => {
    const src = readFileSync(new URL('../../../src/studio/escalation-counters.ts', import.meta.url), 'utf-8');
    expect(src).not.toMatch(/\bfetch\(|https?:\/\/|node:http|undici|axios/);
  });
});

describe('doctor formatting', () => {
  it('reports the served rate and says the counters never leave the machine', () => {
    const lines = formatEscalationCounterLines({
      bridgeAttempted: 4, bridgeServed: 3, bridgeDeclined: 1,
      budgetRefused: 2, cardShown: 1, cardApproved: 1, cardRefused: 0, cardUnattended: 5,
    });
    expect(lines.join('\n')).toContain('served 75%');
    expect(lines.join('\n')).toContain('local only');
  });

  it('reports n/a rather than a divide-by-zero rate before the bridge has ever run', () => {
    const lines = formatEscalationCounterLines(readEscalationCounters(dir));
    expect(lines.join('\n')).toContain('n/a');
  });
});
