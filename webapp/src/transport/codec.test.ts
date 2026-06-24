import { describe, it, expect } from 'vitest';
import { parseDownMessage, encodeUp, up } from './codec.js';

describe('Studio stream codec (S3) — down parsing', () => {
  it('parses every down-schema variant the host emits', () => {
    expect(parseDownMessage(JSON.stringify({ t: 'hello', sessionId: 's1', holder: 'human', epoch: 0 }))).toEqual({ t: 'hello', sessionId: 's1', holder: 'human', epoch: 0 });
    expect(parseDownMessage({ t: 'frame', data: 'BASE64', meta: { w: 1 } })).toEqual({ t: 'frame', data: 'BASE64', meta: { w: 1 } });
    expect(parseDownMessage({ t: 'control', holder: 'agent', epoch: 3 })).toEqual({ t: 'control', holder: 'agent', epoch: 3 });
    expect(parseDownMessage({ t: 'error', reason: 'not_control_holder' })).toEqual({ t: 'error', reason: 'not_control_holder' });
    expect(parseDownMessage({ t: 'approval_request', id: 7, action: 'click', risk: 'money', target: { url: 'https://x' } }))
      .toEqual({ t: 'approval_request', id: 7, action: 'click', risk: 'money', target: { url: 'https://x' } });
  });

  it('drops malformed / unknown messages as null (never throws)', () => {
    expect(parseDownMessage('not json{')).toBeNull();
    expect(parseDownMessage({ t: 'frame' })).toBeNull(); // missing data
    expect(parseDownMessage({ t: 'control', holder: 'human' })).toBeNull(); // missing epoch
    expect(parseDownMessage({ t: 'wat' })).toBeNull(); // unknown discriminant
    expect(parseDownMessage(42)).toBeNull();
    expect(parseDownMessage(null)).toBeNull();
  });

  // PIN-S3 (down discriminant): a {t:'frame'} payload MUST parse to the frame variant. NAMED mutation that
  // REDs: change the parser's `case 'frame'` discriminant to `case 'frma'` → a real frame parses to null and
  // the frame-render path never fires (not silently ignored — this assertion fails).
  it('PIN-S3: a frame message parses to the frame variant (renderable)', () => {
    const parsed = parseDownMessage({ t: 'frame', data: 'JPEGB64' });
    expect(parsed).not.toBeNull();
    expect(parsed!.t).toBe('frame');
    expect((parsed as { t: 'frame'; data: string }).data).toBe('JPEGB64');
  });

  // 7c S4: the two marks down-messages the host emits — the post-hello backfill snapshot and the live delta.
  it('parses the marks_snapshot backfill (the post-hello per-connection hydrate)', () => {
    const snap = parseDownMessage({ t: 'marks_snapshot', marks: [{ markId: 'm1', role: 'button', name: 'Add', trusted: false, confidence: 'high', ref: 'e3' }] });
    expect(snap).toEqual({ t: 'marks_snapshot', marks: [{ markId: 'm1', role: 'button', name: 'Add', confidence: 'high', ref: 'e3' }] });
  });

  it('parses the live mark delta (top-level StudioMarkView fields)', () => {
    expect(parseDownMessage({ t: 'mark', markId: 'm2', role: 'link', name: 'More', trusted: false, confidence: 'low' }))
      .toEqual({ t: 'mark', markId: 'm2', role: 'link', name: 'More', confidence: 'low' });
  });

  it('drops a malformed marks message as null (missing required descriptor)', () => {
    expect(parseDownMessage({ t: 'mark', markId: 'm3', role: 'button' })).toBeNull(); // no name/confidence
    expect(parseDownMessage({ t: 'marks_snapshot' })).toBeNull(); // no marks array
    // a snapshot drops only the malformed entries, keeps the valid ones (never throws)
    expect(parseDownMessage({ t: 'marks_snapshot', marks: [{ markId: 'ok', role: 'button', name: 'X', confidence: 'none' }, { junk: 1 }] }))
      .toEqual({ t: 'marks_snapshot', marks: [{ markId: 'ok', role: 'button', name: 'X', confidence: 'none' }] });
  });
});

describe('Studio stream codec (S3) — up encoding', () => {
  it('builds + encodes every up-schema variant the host routes on', () => {
    expect(JSON.parse(encodeUp(up.ack()))).toEqual({ t: 'ack' });
    expect(JSON.parse(encodeUp(up.input({ kind: 'mouse', epoch: 2, x: 10, y: 20 })))).toEqual({ t: 'input', kind: 'mouse', epoch: 2, x: 10, y: 20 });
    expect(JSON.parse(encodeUp(up.control('reclaim')))).toEqual({ t: 'control', op: 'reclaim' });
    expect(JSON.parse(encodeUp(up.control('grant', 'agent')))).toEqual({ t: 'control', op: 'grant', to: 'agent' });
    expect(JSON.parse(encodeUp(up.nav('https://example.com')))).toEqual({ t: 'nav', url: 'https://example.com' });
    expect(JSON.parse(encodeUp(up.mark()))).toEqual({ t: 'mark' });
    expect(JSON.parse(encodeUp(up.approval(7, 'approve')))).toEqual({ t: 'approval', id: 7, decision: 'approve' });
  });

  // PIN-S3 (up emit type): the nav up-message MUST carry t:'nav' (the host routes on it). NAMED mutation
  // that REDs: change up.nav to emit `t: 'navv'` → the host would never route it and this assertion fails.
  it('PIN-S3: up.nav emits the t:"nav" discriminant the host routes on', () => {
    expect(JSON.parse(encodeUp(up.nav('u'))).t).toBe('nav');
  });
});
