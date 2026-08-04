/**
 * P1a — Studio as a ToolProvider. The point of this file is that the studio tool surface is
 * DERIVED, never hand-listed: one addition to TOOL_DESCRIPTIONS + TOOL_SCHEMAS reaches tools/list
 * AND dispatch on both the stdio server and the gateway, with no literal name list in between.
 *
 * Two seams these tests hold shut:
 *  - advertised ⇔ dispatchable. Before the registry, tools/list and the dispatch guard were two
 *    independent literals, so a name present in one and absent from the other 404'd at runtime
 *    with a green typecheck.
 *  - studio_fetch stays a capability, not a tool. It is callable over the gateway's already
 *    authenticated transport but must never appear in tools/list.
 */
import { describe, it, expect } from 'vitest';
import { createStudioToolProvider, STUDIO_TOOLS } from '../../../src/studio/tool-provider.js';
import type { StudioHostHandlers } from '../../../src/daemon/studio-dispatch.js';
import { TOOL_DESCRIPTIONS } from '../../../src/instructions.js';
import { TOOL_SCHEMAS } from '../../../src/server/tool-schemas.js';

const hostHandlers = (): StudioHostHandlers => ({
  observe: async () => ({ id: 's', kind: 'full', trusted: false, untrusted_notice: 'n', elements: [], events: [], eventCursor: 0, eventsDropped: 0, domTruncated: false }),
  act: async (i) => ({ ok: true, action: i.action }),
  marks: async () => ({ marks: [], untrusted_notice: 'n' }),
  capture: async () => ({ artifact_id: 1, inserted: true, content_hash: 'h' }),
  spawn: async () => ({ session_id: 'sess-1' }),
  close: async (i) => ({ closed: true as const, session_id: i.session_id ?? '' }),
  list: async () => ({ sessions: [] }),
  say: async () => ({ posted: true, posted_at: 0 }),
  extractSet: async () => ({ columns: [], rows: [], pages_followed: 0 }),
});

const provider = () => createStudioToolProvider({ getHost: () => hostHandlers() });

describe('createStudioToolProvider — the derived studio surface', () => {
  it('advertises exactly the studio_-prefixed tools, in the tool-schema order the stdio server used to hand-list', () => {
    expect(provider().tools.map((t) => t.name)).toEqual([
      'studio_open', 'studio_observe', 'studio_act', 'studio_marks', 'studio_capture',
      'studio_extract_set', 'studio_say', 'studio_spawn', 'studio_close', 'studio_list',
    ]);
  });

  it('is derived, not hand-listed: every studio_ key of TOOL_DESCRIPTIONS is advertised with its own schema + description', () => {
    // The anti-drift assertion. A hand-written list can go stale silently (tests/unit/instructions-v3
    // carried a 14-name list against a 20-name union for two phases); this one cannot.
    const fromDescriptions = Object.keys(TOOL_DESCRIPTIONS).filter((k) => k.startsWith('studio_')).sort();
    expect(STUDIO_TOOLS.map((t) => t.name).sort()).toEqual(fromDescriptions);
    for (const t of STUDIO_TOOLS) {
      expect(t.description).toBe(TOOL_DESCRIPTIONS[t.name]);
      expect(t.inputSchema).toBe(TOOL_SCHEMAS[t.name]);
      expect(t.inputSchema.type).toBe('object');
    }
  });

  it('handles exactly what it advertises — no advertised-but-undispatchable, no core tool captured', () => {
    const p = provider();
    for (const t of p.tools) expect(p.handles(t.name)).toBe(true);
    for (const other of ['fetch', 'search', 'watch', 'studio', 'studio_bogus']) {
      expect(p.handles(other)).toBe(false);
    }
  });

  it('does NOT handle studio_fetch — the broker capability stays off tools/list and off core dispatch', () => {
    // It is served by the gateway's own capability branch over an authenticated transport. A
    // provider that claimed it would advertise it, turning one seam back into six.
    expect(provider().handles('studio_fetch')).toBe(false);
    expect(STUDIO_TOOLS.map((t) => t.name)).not.toContain('studio_fetch');
  });

  it('every advertised tool reaches a host handler — none falls through to unknown_studio_tool', async () => {
    // THE runtime-404 guard. Add a studio tool without a dispatch route and this reds, instead of
    // the agent discovering it via a refusal in production.
    const p = provider();
    for (const t of p.tools) {
      const r = await p.dispatch(t.name, t.name === 'studio_act' ? { action: 'scroll' } : {});
      const body = JSON.parse(r.content[0].text) as { error_reason?: string };
      expect(body.error_reason, `${t.name} has no host route`).not.toBe('unknown_studio_tool');
    }
  });

  it('reads the host lazily, so a host injected AFTER the MCP server is built is still used', async () => {
    // DaemonHttpServer.setStudioHost is a late setter — capturing the value at construction time
    // would leave every session that connected first permanently on the proxy path.
    let host: StudioHostHandlers | undefined;
    const p = createStudioToolProvider({ getHost: () => host });
    host = hostHandlers();
    const r = await p.dispatch('studio_list', {});
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.content[0].text)).toEqual({ sessions: [] });
  });
});
