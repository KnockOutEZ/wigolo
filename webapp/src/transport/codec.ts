/**
 * The Studio stream wire codec (S3) — the single boundary between the untyped WebSocket and the typed app.
 *
 * DOWN (host → tab): `parseDownMessage` validates the `t` discriminant + the minimal fields each variant
 * needs and returns a typed union; anything malformed or unknown returns null (never throws) so attacker /
 * garbage frames are dropped, not crashed on. The host's down-schema is the source of truth (see
 * src/studio/ws-hub.ts broadcast/broadcastFrame): hello, frame, control, error, approval_request.
 *
 * UP (tab → host): the `up` builders produce the exact shapes the host routes on (ws-hub onMessage cases:
 * ack, input, control, nav, mark, approval). The bearer/party are never carried here — the WS itself is the
 * authenticated human channel (the host stamps party='human'), so the tab can never claim to be the agent.
 */

export type ControlParty = 'human' | 'agent';
export type ControlOp = 'reclaim' | 'grant' | 'release';

/**
 * One human mark as the read surface shows it (7c S4): the host-built StudioMarkView minus the agent-only
 * `trusted` tag. role/name are page-derived UNTRUSTED strings — the panel renders them via SafeText.
 * `confidence` is the host's heal-computed verdict (high/medium/low/none).
 */
export interface MarkView {
  markId: string;
  role: string;
  name: string;
  confidence: string;
  ref?: string;
}

/**
 * One pending risky-action approval as the card shows it (7d S1): the host-sent {t:'approval_request'} payload
 * minus the discriminant. `target` carries only the URL / opaque host ref — never page content — but is still
 * routed through SafeText on render (defence in depth). `action`/`risk` are host-authoritative; the card shows
 * them verbatim and never re-derives risk on the client.
 */
export interface ApprovalRequestView {
  id: number;
  action: string;
  risk: string;
  target?: { url?: string; ref?: string };
}

/**
 * One audit-trail entry as the timeline shows it (7d S4): the host-broadcast frozen AuditEntry. action /
 * outcome.error_reason / target.* are host-relayed but may echo page-derived content, so the panel renders
 * each through SafeText as inert text. Append-only + replay-ordered by `seq`.
 */
export interface AuditView {
  seq: number;
  ts: number;
  action: string;
  epoch: number;
  outcome: { ok: boolean; error_reason?: string; charsLanded?: number };
  risk?: string;
  approval?: string;
  target?: { url?: string; ref?: string; direction?: string; amount?: number };
}

/**
 * One human comment/annotation as the read surface shows it (7b-notes S3): the host's captured-note echo minus
 * the implicit `trusted` tag (a comment is human-authored → always trusted; the panel never re-derives trust).
 * `text` is human-authored but still rendered via SafeText (inert) — uniform with every other relayed string.
 * `id` is the persisted artifact id (the list key).
 */
export interface CommentView {
  id: number;
  text: string;
}

/**
 * One captured item (clip/qa) as the captured-items panel shows it (7e S3): the host's light projection. id is
 * the persisted artifact id (the list key + upsert key). title/url are page-derived UNTRUSTED strings — the
 * panel renders them via SafeText; a null/absent title or url is coerced to '' at the seam (a url-less qa).
 * `trusted` is the host-authoritative content_trusted flag the badge reflects verbatim (never re-derived).
 */
export interface ArtifactView {
  id: number;
  type: string;
  title: string;
  url: string;
  trusted: boolean;
  created_at: string;
}

export type DownMessage =
  | { t: 'hello'; sessionId: string; holder?: ControlParty; epoch?: number }
  | { t: 'frame'; data: string; meta?: unknown }
  | { t: 'control'; holder: ControlParty; epoch: number }
  | { t: 'error'; reason: string }
  | { t: 'approval_request'; id: number; action: string; risk: string; target?: { url?: string; ref?: string } }
  | { t: 'marks_snapshot'; marks: MarkView[] }
  | { t: 'mark'; markId: string; role: string; name: string; confidence: string; ref?: string }
  | ({ t: 'audit' } & AuditView)
  | { t: 'audit_snapshot'; entries: AuditView[] }
  | { t: 'comment_snapshot'; comments: CommentView[] }
  | { t: 'comment'; id: number; text: string }
  | { t: 'artifact_snapshot'; items: ArtifactView[] }
  | ({ t: 'artifact' } & ArtifactView);

export type UpMessage =
  | { t: 'ack' }
  | { t: 'input'; [k: string]: unknown }
  | { t: 'control'; op: ControlOp; to?: ControlParty }
  | { t: 'nav'; url: string }
  | { t: 'mark' }
  | { t: 'approval'; id: number; decision: string }
  | { t: 'comment'; text: string };

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null;
}

/** Parse one host-built mark descriptor (shared by the snapshot + delta paths); null if any required field is malformed. */
function parseMarkView(o: unknown): MarkView | null {
  if (!isObj(o)) return null;
  if (typeof o.markId !== 'string' || typeof o.role !== 'string' || typeof o.name !== 'string' || typeof o.confidence !== 'string') return null;
  return { markId: o.markId, role: o.role, name: o.name, confidence: o.confidence, ...(typeof o.ref === 'string' ? { ref: o.ref } : {}) };
}

/** Parse one host-echoed comment (shared by the snapshot + delta paths); null if id/text is malformed. The
 * `trusted` tag is intentionally dropped — a comment is always human-authored/trusted on this surface. */
function parseCommentView(o: unknown): CommentView | null {
  if (!isObj(o)) return null;
  if (typeof o.id !== 'number' || typeof o.text !== 'string') return null;
  return { id: o.id, text: o.text };
}

/** Parse one host-broadcast captured item (shared by the delta + snapshot paths); null if id/type/trusted/created_at
 * is malformed. title/url are coerced: a string passes through, anything else (null/absent) becomes '' (a url-less qa). */
function parseArtifactView(o: unknown): ArtifactView | null {
  if (!isObj(o)) return null;
  if (typeof o.id !== 'number' || typeof o.type !== 'string' || typeof o.trusted !== 'boolean' || typeof o.created_at !== 'string') return null;
  return {
    id: o.id,
    type: o.type,
    title: typeof o.title === 'string' ? o.title : '',
    url: typeof o.url === 'string' ? o.url : '',
    trusted: o.trusted,
    created_at: o.created_at,
  };
}

/** Parse one host-broadcast audit entry (shared by the delta + snapshot paths); null if any required field is malformed. */
function parseAuditEntry(o: unknown): AuditView | null {
  if (!isObj(o)) return null;
  if (typeof o.seq !== 'number' || typeof o.ts !== 'number' || typeof o.action !== 'string' || typeof o.epoch !== 'number') return null;
  if (!isObj(o.outcome) || typeof o.outcome.ok !== 'boolean') return null;
  const outcome: AuditView['outcome'] = { ok: o.outcome.ok };
  if (typeof o.outcome.error_reason === 'string') outcome.error_reason = o.outcome.error_reason;
  if (typeof o.outcome.charsLanded === 'number') outcome.charsLanded = o.outcome.charsLanded;
  const view: AuditView = { seq: o.seq, ts: o.ts, action: o.action, epoch: o.epoch, outcome };
  if (typeof o.risk === 'string') view.risk = o.risk;
  if (typeof o.approval === 'string') view.approval = o.approval;
  if (isObj(o.target)) {
    const t: NonNullable<AuditView['target']> = {};
    if (typeof o.target.url === 'string') t.url = o.target.url;
    if (typeof o.target.ref === 'string') t.ref = o.target.ref;
    if (typeof o.target.direction === 'string') t.direction = o.target.direction;
    if (typeof o.target.amount === 'number') t.amount = o.target.amount;
    if (Object.keys(t).length) view.target = t;
  }
  return view;
}

/** Parse an inbound WS payload (string or pre-parsed object) into a typed down-message, or null if malformed/unknown. */
export function parseDownMessage(raw: unknown): DownMessage | null {
  let m: unknown = raw;
  if (typeof raw === 'string') {
    try {
      m = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!isObj(m)) return null;
  switch (m.t) {
    case 'hello':
      if (typeof m.sessionId !== 'string') return null;
      return {
        t: 'hello',
        sessionId: m.sessionId,
        ...(m.holder === 'human' || m.holder === 'agent' ? { holder: m.holder } : {}),
        ...(typeof m.epoch === 'number' ? { epoch: m.epoch } : {}),
      };
    case 'frame':
      if (typeof m.data !== 'string') return null;
      return { t: 'frame', data: m.data, ...(m.meta !== undefined ? { meta: m.meta } : {}) };
    case 'control':
      if ((m.holder !== 'human' && m.holder !== 'agent') || typeof m.epoch !== 'number') return null;
      return { t: 'control', holder: m.holder, epoch: m.epoch };
    case 'error':
      if (typeof m.reason !== 'string') return null;
      return { t: 'error', reason: m.reason };
    case 'approval_request':
      if (typeof m.id !== 'number' || typeof m.action !== 'string' || typeof m.risk !== 'string') return null;
      return {
        t: 'approval_request',
        id: m.id,
        action: m.action,
        risk: m.risk,
        ...(isObj(m.target) ? { target: m.target as { url?: string; ref?: string } } : {}),
      };
    case 'marks_snapshot': {
      if (!Array.isArray(m.marks)) return null;
      // Drop only the malformed entries — a single bad mark never voids the whole backfill.
      const marks = m.marks.map(parseMarkView).filter((x): x is MarkView => x !== null);
      return { t: 'marks_snapshot', marks };
    }
    case 'mark': {
      const mv = parseMarkView(m);
      return mv ? { t: 'mark', ...mv } : null;
    }
    case 'audit': {
      const av = parseAuditEntry(m);
      return av ? { t: 'audit', ...av } : null;
    }
    case 'audit_snapshot': {
      if (!Array.isArray(m.entries)) return null;
      // Drop only the malformed entries — a single bad entry never voids the whole backfill.
      const entries = m.entries.map(parseAuditEntry).filter((x): x is AuditView => x !== null);
      return { t: 'audit_snapshot', entries };
    }
    case 'comment': {
      const cv = parseCommentView(m);
      return cv ? { t: 'comment', ...cv } : null;
    }
    case 'comment_snapshot': {
      if (!Array.isArray(m.comments)) return null;
      // Drop only the malformed entries — a single bad comment never voids the whole backfill.
      const comments = m.comments.map(parseCommentView).filter((x): x is CommentView => x !== null);
      return { t: 'comment_snapshot', comments };
    }
    case 'artifact': {
      const av = parseArtifactView(m);
      return av ? { t: 'artifact', ...av } : null;
    }
    case 'artifact_snapshot': {
      if (!Array.isArray(m.items)) return null;
      // Drop only the malformed entries — a single bad item never voids the whole backfill.
      const items = m.items.map(parseArtifactView).filter((x): x is ArtifactView => x !== null);
      return { t: 'artifact_snapshot', items };
    }
    default:
      return null;
  }
}

/** Builders for the up-schema — the exact shapes the host's ws-hub routes on. */
export const up = {
  ack(): UpMessage {
    return { t: 'ack' };
  },
  input(payload: Record<string, unknown>): UpMessage {
    return { t: 'input', ...payload };
  },
  control(op: ControlOp, to?: ControlParty): UpMessage {
    return { t: 'control', op, ...(to ? { to } : {}) };
  },
  nav(url: string): UpMessage {
    return { t: 'nav', url };
  },
  mark(): UpMessage {
    return { t: 'mark' };
  },
  approval(id: number, decision: string): UpMessage {
    return { t: 'approval', id, decision };
  },
  comment(text: string): UpMessage {
    return { t: 'comment', text };
  },
};

/** Serialize an up-message for `WebSocket.send`. */
export function encodeUp(msg: UpMessage): string {
  return JSON.stringify(msg);
}
