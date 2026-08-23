// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { App } from '../../src/renderer/App';
import type { StudioApi } from '../../src/preload/index';
import type { StudioState } from '../../src/shared/ipc';

/**
 * Law 8 — the marks/run id is a shared address space: the same string appears in the tab group, the
 * rail badge, the terminal, REST, the replay and the audit log. The SD1 exit gate compares REST, the
 * menu, SQLite and the JSONL byte-for-byte, but of the badge it only pins the NULL branch
 * (`sd1-exit-gate.spec.ts`). So the one thing the badge exists to say — *which run you are inside* —
 * was unpinned: truncating the id to four characters, or inverting the `??`, left every suite green
 * while the address space silently stopped being shared.
 *
 * The badge is asserted as an exact string rather than a `toContain`, because a truncated id still
 * LOOKS like a run id; only byte-identity can tell the two apart.
 */

// React 19 act() needs this flag set for the test environment.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const EMPTY: StudioState = { runs: [], focusedRunId: null, tabs: [] };

let pushState: (s: StudioState) => void = () => {};
let container: HTMLDivElement;
let root: Root;

/**
 * The host, as the renderer sees it. Only the calls whose RESULT the mount effect consumes are
 * spelled out; every other member of the surface is an event subscription or a fire-and-forget
 * command, and a no-op answers those correctly. Written as a proxy so a call App gains later cannot
 * fail this file for a reason that has nothing to do with the badge.
 */
function stubHost(): StudioApi {
  const answers: Record<string, (...args: never[]) => unknown> = {
    onState: (...args: never[]) => { pushState = args[0] as unknown as (s: StudioState) => void; },
    getState: () => Promise.resolve(EMPTY),
    listCaptures: () => Promise.resolve([]),
    listAudit: () => Promise.resolve([]),
    knowledgeSimilar: () => Promise.resolve([]),
    setBannerOpen: () => Promise.resolve(),
    setRailOpen: () => Promise.resolve(),
  };
  const noop = () => undefined;
  return new Proxy({}, { get: (_t, prop) => answers[prop as string] ?? noop }) as unknown as StudioApi;
}

async function mount(): Promise<void> {
  (globalThis as unknown as { studio: StudioApi }).studio = stubHost();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root.render(<App />); });
}

/** The painted badge text, exactly as a person reads it off the rail. */
function badge(): string | null {
  return container.querySelector('.rail__badge')?.textContent ?? null;
}

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
  pushState = () => {};
});

describe('the rail badge names the run you are inside', () => {
  it('paints the focused run id byte-for-byte — no truncation, no case change, no decoration', async () => {
    await mount();
    // A long, mixed id: a `.slice(0, 4)` or an upper/lowercasing still yields something that reads
    // like a run id, so only the whole string distinguishes them.
    await act(async () => { pushState({ ...EMPTY, focusedRunId: 'q7f2mn93' }); });

    expect(badge()).toBe('q7f2mn93');
  });

  it('says `no run` — and nothing that looks like an id — when no run is focused', async () => {
    await mount();
    await act(async () => { pushState({ ...EMPTY, focusedRunId: null }); });

    expect(badge()).toBe('no run');
  });

  it('names the FOCUSED run, not whichever run the list happens to start with', async () => {
    // An implementation reaching for `runs[0].id` reads identically on a single-run machine, and the
    // badge would then point at a run you are not talking to.
    await mount();
    await act(async () => {
      pushState({
        runs: [
          { id: 'aaaa1111', task: 'first', status: 'running', tabIds: [] },
          { id: 'bbbb2222', task: 'second', status: 'running', tabIds: [] },
        ],
        focusedRunId: 'bbbb2222',
        tabs: [],
      });
    });

    expect(badge()).toBe('bbbb2222');
  });

  it('falls back to `no run` again when the focused run goes away', async () => {
    await mount();
    await act(async () => { pushState({ ...EMPTY, focusedRunId: 'q7f2mn93' }); });
    expect(badge()).toBe('q7f2mn93');

    await act(async () => { pushState({ ...EMPTY, focusedRunId: null }); });
    expect(badge()).toBe('no run');
  });
});
