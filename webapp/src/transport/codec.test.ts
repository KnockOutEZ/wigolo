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

  // S2b: the agent→human narration down-message. Parses to {t:'narration',text}; the `trusted` tag is dropped
  // (a narration is ALWAYS agent-authored/untrusted on this surface and rendered inert via SafeText). NAMED
  // mutation that REDs: drop the `case 'narration'` from parseDownMessage → a real narration parses to null and
  // never reaches the panel.
  it('S2b: parses an agent narration to {t:narration, text}; malformed (no text) is null', () => {
    expect(parseDownMessage({ t: 'narration', text: 'reading the page', trusted: false })).toEqual({ t: 'narration', text: 'reading the page' });
    expect(parseDownMessage({ t: 'narration' })).toBeNull(); // missing text
    expect(parseDownMessage({ t: 'narration', text: 42 })).toBeNull(); // non-string text
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

  it('parses the live audit delta (7d S4 — the frozen entry the host broadcasts)', () => {
    expect(parseDownMessage({ t: 'audit', seq: 5, ts: 1700, action: 'click', epoch: 2, outcome: { ok: false, error_reason: 'not_holder' }, risk: 'money', target: { ref: 'e1' } }))
      .toEqual({ t: 'audit', seq: 5, ts: 1700, action: 'click', epoch: 2, outcome: { ok: false, error_reason: 'not_holder' }, risk: 'money', target: { ref: 'e1' } });
  });

  it('parses the audit_snapshot backfill, dropping only malformed entries', () => {
    const snap = parseDownMessage({ t: 'audit_snapshot', entries: [
      { seq: 1, ts: 1001, action: 'navigate', epoch: 0, outcome: { ok: true }, target: { url: 'https://a/' } },
      { junk: 1 }, // malformed — dropped, not thrown
    ] });
    expect(snap).toEqual({ t: 'audit_snapshot', entries: [
      { seq: 1, ts: 1001, action: 'navigate', epoch: 0, outcome: { ok: true }, target: { url: 'https://a/' } },
    ] });
  });

  it('drops a malformed audit message as null (missing seq/ts/outcome)', () => {
    expect(parseDownMessage({ t: 'audit', action: 'click', epoch: 0, outcome: { ok: true } })).toBeNull(); // no seq/ts
    expect(parseDownMessage({ t: 'audit', seq: 1, ts: 2, action: 'click', epoch: 0 })).toBeNull(); // no outcome
    expect(parseDownMessage({ t: 'audit_snapshot' })).toBeNull(); // no entries array
  });

  // ── 7b-notes S3: comment delta + comment_snapshot backfill ──
  it('parses the live comment delta (the host echo of a captured human comment)', () => {
    expect(parseDownMessage({ t: 'comment', id: 7, text: 'renew the cert', trusted: true }))
      .toEqual({ t: 'comment', id: 7, text: 'renew the cert' }); // trusted is implicit for comments — dropped at the seam
  });

  it('parses the comment_snapshot backfill, dropping only malformed entries', () => {
    const snap = parseDownMessage({ t: 'comment_snapshot', comments: [
      { id: 1, text: 'first' },
      { id: 'nope' }, // malformed — dropped, not thrown
    ] });
    expect(snap).toEqual({ t: 'comment_snapshot', comments: [{ id: 1, text: 'first' }] });
  });

  it('drops a malformed comment message as null (missing id/text)', () => {
    expect(parseDownMessage({ t: 'comment', text: 'no id' })).toBeNull(); // no id
    expect(parseDownMessage({ t: 'comment', id: 1 })).toBeNull(); // no text
    expect(parseDownMessage({ t: 'comment_snapshot' })).toBeNull(); // no comments array
  });

  // ── 7e S3: captured-item delta + artifact_snapshot backfill ──
  it('parses the live artifact delta (a host-broadcast captured clip/qa)', () => {
    expect(parseDownMessage({ t: 'artifact', id: 7, type: 'clip', title: 'Deal', url: 'https://x.example/p', trusted: false, created_at: '2026-06-24T00:00:00.000Z' }))
      .toEqual({ t: 'artifact', id: 7, type: 'clip', title: 'Deal', url: 'https://x.example/p', trusted: false, created_at: '2026-06-24T00:00:00.000Z' });
  });

  it('coerces a null/absent title or url to an empty string (a url-less qa)', () => {
    expect(parseDownMessage({ t: 'artifact', id: 8, type: 'qa', title: 'why?', url: null, trusted: false, created_at: '2026-06-24T00:00:00.000Z' }))
      .toEqual({ t: 'artifact', id: 8, type: 'qa', title: 'why?', url: '', trusted: false, created_at: '2026-06-24T00:00:00.000Z' });
  });

  it('parses the artifact_snapshot backfill, dropping only malformed entries', () => {
    const snap = parseDownMessage({ t: 'artifact_snapshot', items: [
      { id: 1, type: 'clip', title: 'a', url: 'https://x.example/1', trusted: false, created_at: '2026-06-24T00:00:00.000Z' },
      { id: 'nope' }, // malformed — dropped, not thrown
    ] });
    expect(snap).toEqual({ t: 'artifact_snapshot', items: [{ id: 1, type: 'clip', title: 'a', url: 'https://x.example/1', trusted: false, created_at: '2026-06-24T00:00:00.000Z' }] });
  });

  it('drops a malformed artifact message as null (missing id/type/trusted/created_at)', () => {
    expect(parseDownMessage({ t: 'artifact', type: 'clip', trusted: false, created_at: 'x' })).toBeNull(); // no id
    expect(parseDownMessage({ t: 'artifact', id: 1, trusted: false, created_at: 'x' })).toBeNull(); // no type
    expect(parseDownMessage({ t: 'artifact', id: 1, type: 'clip', created_at: 'x' })).toBeNull(); // no trusted
    expect(parseDownMessage({ t: 'artifact', id: 1, type: 'clip', trusted: false })).toBeNull(); // no created_at
    expect(parseDownMessage({ t: 'artifact_snapshot' })).toBeNull(); // no items array
  });

  // ── 7f B3: sessions_snapshot backfill + sessions delta (the switcher trust boundary) ──
  it('parses the sessions_snapshot backfill, dropping only malformed entries', () => {
    const snap = parseDownMessage({ t: 'sessions_snapshot', sessions: [
      { id: 'sess-1', status: 'active', clients: 1, createdAt: 1000, lastActiveAt: 2000 },
      { id: 'no-status' }, // malformed — dropped, not thrown
    ] });
    expect(snap).toEqual({ t: 'sessions_snapshot', sessions: [
      { id: 'sess-1', status: 'active', clients: 1, createdAt: 1000, lastActiveAt: 2000 },
    ] });
  });

  it('parses the live sessions delta', () => {
    expect(parseDownMessage({ t: 'sessions', sessions: [{ id: 's2', status: 'idle', clients: 0, createdAt: 5, lastActiveAt: 9 }] }))
      .toEqual({ t: 'sessions', sessions: [{ id: 's2', status: 'idle', clients: 0, createdAt: 5, lastActiveAt: 9 }] });
  });

  // TRUST at the codec boundary: a token/url a buggy or hostile host slips into the payload is DROPPED — the
  // parsed entry carries only the five metadata fields, never a credential or url.
  it('strips any token/url field from a session entry (metadata-only, defense in depth)', () => {
    const snap = parseDownMessage({ t: 'sessions', sessions: [
      { id: 's1', status: 'active', clients: 1, createdAt: 1, lastActiveAt: 2, token: 'LEAK', endpoint: 'http://x', url: 'http://y' },
    ] });
    expect(snap?.t).toBe('sessions');
    if (!snap || snap.t !== 'sessions') throw new Error('expected a sessions message');
    expect(Object.keys(snap.sessions[0]).sort()).toEqual(['clients', 'createdAt', 'id', 'lastActiveAt', 'status']);
    expect('token' in snap.sessions[0]).toBe(false);
  });

  it('drops a malformed session message as null (missing id/status/numbers; no sessions array)', () => {
    expect(parseDownMessage({ t: 'sessions', sessions: [{ status: 'active', clients: 1, createdAt: 1, lastActiveAt: 2 }] }))
      .toEqual({ t: 'sessions', sessions: [] }); // entry missing id → dropped
    expect(parseDownMessage({ t: 'sessions_snapshot' })).toBeNull(); // no sessions array
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
    expect(JSON.parse(encodeUp(up.comment('renew the cert')))).toEqual({ t: 'comment', text: 'renew the cert' });
  });

  // PIN (up emit type): the comment up-message MUST carry t:'comment' (the host routes on it). NAMED mutation
  // that REDs: change up.comment to emit a different discriminant → the host never routes it and this fails.
  it('PIN: up.comment emits the t:"comment" discriminant the host routes on', () => {
    expect(JSON.parse(encodeUp(up.comment('x'))).t).toBe('comment');
  });

  // PIN-S3 (up emit type): the nav up-message MUST carry t:'nav' (the host routes on it). NAMED mutation
  // that REDs: change up.nav to emit `t: 'navv'` → the host would never route it and this assertion fails.
  it('PIN-S3: up.nav emits the t:"nav" discriminant the host routes on', () => {
    expect(JSON.parse(encodeUp(up.nav('u'))).t).toBe('nav');
  });
});
