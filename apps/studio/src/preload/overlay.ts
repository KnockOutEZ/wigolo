/**
 * Per-tab marking overlay — runs in the WebContentsView's ISOLATED world (contextIsolation), so page
 * JS cannot read its variables; its UI lives in a CLOSED shadow root on an `[data-wigolo-overlay]`
 * host, so page CSS cannot style it and the host-side snapshot filters it out (DR-4). Thin DOM/IPC
 * wiring around the pure `overlay-core` helpers.
 *
 * Self-containment: a SANDBOXED preload cannot load sibling build chunks, so this entry imports only
 * `electron` (a runtime builtin the sandbox provides) + `./overlay-core` (overlay-only → inlined by the
 * bundler). It deliberately does NOT import the shared `../shared/ipc` runtime `IPC` const (shared with
 * the chrome preload → would hoist a chunk); the four channel strings are duplicated as local consts
 * (kept in sync with shared/ipc.ts's IPC.overlay* entries — the e2e exercises the real wire).
 */
import { ipcRenderer } from 'electron';
import { elementPath, serializePayload, whiskerLabel, ancestorWalk, serializeQuote, rectFromPoints, ghostCursorPlacement, type MarkPayload } from './overlay-core';

// Channel strings — MUST equal shared/ipc.ts IPC.overlay* (not imported to keep this bundle self-contained).
const CH = {
  mark: 'studio:overlay-mark',
  generalize: 'studio:overlay-generalize',
  quote: 'studio:overlay-quote',
  region: 'studio:overlay-region',
  arm: 'studio:overlay-arm',
  assigned: 'studio:overlay-mark-assigned',
  cursor: 'studio:overlay-cursor',
  clipArm: 'studio:clip-arm',
} as const;

interface OverlayMarkMsg { nonce: string; path: number[]; payload: MarkPayload }

// Only the top frame draws the overlay (marks are page-level; sub-frame marking is out of P2 scope).
if (typeof window !== 'undefined' && window.top === window && typeof document !== 'undefined') {
  installOverlay();
}

function installOverlay(): void {
  type Mode = 'idle' | 'hover' | 'marked';
  let mode: Mode = 'idle';
  let current: Element | null = null;
  let armedByAlt = false;
  let markSeq = 0;
  // nonce → the chip element awaiting its assigned number (from the main-process echo).
  const pendingChips = new Map<string, HTMLElement>();

  // ── Closed-shadow host (page-isolated; excluded from the agent snapshot via the data attr + aria-hidden) ──
  const host = document.createElement('div');
  host.setAttribute('data-wigolo-overlay', '1');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      .outline { position: fixed; pointer-events: none; border: 2px solid #a06bff; border-radius: 6px;
        box-shadow: 0 0 0 2px rgba(160,107,255,.28), 0 0 18px rgba(160,107,255,.35); transition: all .06s ease; display: none; }
      .outline.marked { border-color: #a06bff; box-shadow: 0 0 0 2px rgba(160,107,255,.5); }
      .whisker { position: fixed; pointer-events: none; font: 11px ui-monospace, monospace; color: #f4f0ff;
        background: #1b1526; border: 1px solid #3a2f52; border-radius: 5px; padding: 2px 7px; white-space: nowrap; display: none; }
      .chip { position: fixed; pointer-events: none; font: 11px ui-sans-serif, system-ui; color: #f4f0ff;
        background: #6f4ad1; border-radius: 999px; padding: 2px 8px; transform: translateY(-50%); }
      .cliprect { position: fixed; pointer-events: none; border: 1.5px dashed #a06bff; border-radius: 4px;
        background: rgba(160,107,255,.12); display: none; }
      .cliphint { position: fixed; left: 50%; top: 12px; transform: translateX(-50%); pointer-events: none;
        font: 12px ui-sans-serif, system-ui; color: #f4f0ff; background: #1b1526; border: 1px solid #3a2f52;
        border-radius: 6px; padding: 4px 10px; display: none; }
      .bar { position: fixed; pointer-events: auto; display: none; gap: 4px; background: #171320; border: 1px solid #34294c;
        border-radius: 8px; padding: 4px; box-shadow: 0 6px 20px rgba(0,0,0,.4); }
      .bar button { all: unset; cursor: pointer; font: 13px ui-sans-serif, system-ui; color: #e9e3f7; padding: 3px 7px; border-radius: 5px; }
      .bar button:hover { background: #2a2140; }
      .bar button[disabled] { opacity: .4; cursor: default; }
      .ghost { position: fixed; pointer-events: none; width: 18px; height: 18px; margin: -2px 0 0 -2px;
        transition: left .18s cubic-bezier(.2,.8,.2,1), top .18s cubic-bezier(.2,.8,.2,1); display: none; z-index: 3; }
      .ghost svg { filter: drop-shadow(0 0 6px rgba(160,107,255,.7)); }
      .ghostcap { position: fixed; pointer-events: none; font: 12px ui-sans-serif, system-ui; color: #f4f0ff;
        background: rgba(111,74,209,.92); border-radius: 6px; padding: 3px 9px; white-space: nowrap; display: none; z-index: 3; }
    </style>
    <div class="outline"></div>
    <div class="whisker"></div>
    <div class="cliprect"></div>
    <div class="cliphint">Drag to clip a region · Esc to cancel</div>
    <div class="ghost"><svg viewBox="0 0 18 18" width="18" height="18"><path d="M2 2l14 6-6 2-2 6z" fill="#a06bff"/></svg></div>
    <div class="ghostcap"></div>
    <div class="chips"></div>
    <div class="bar">
      <button data-act="comment" title="Comment (type in the Marks panel →)">💬</button>
      <button data-act="grab">⧉</button>
      <button data-act="watch" disabled title="Watch — arrives later (P7)">👁</button>
      <button data-act="send" disabled title="Send to agent — arrives later (P4)">➤</button>
    </div>`;
  const outline = root.querySelector('.outline') as HTMLElement;
  const whisker = root.querySelector('.whisker') as HTMLElement;
  const chips = root.querySelector('.chips') as HTMLElement;
  const bar = root.querySelector('.bar') as HTMLElement;
  const cliprect = root.querySelector('.cliprect') as HTMLElement;
  const cliphint = root.querySelector('.cliphint') as HTMLElement;
  const ghost = root.querySelector('.ghost') as HTMLElement;
  const ghostcap = root.querySelector('.ghostcap') as HTMLElement;
  let ghostTimer = 0; // the ghost cursor fades a short while after the agent's last act
  let activeMarkId: string | null = null; // the mark the action bar currently targets
  // ── Region clip (⌘⇧X arms; drag a rectangle; Esc cancels) ──
  let clipMode = false;
  let clipStart: { x: number; y: number } | null = null;
  const setClip = (on: boolean): void => { clipMode = on; clipStart = null; cliphint.style.display = on ? 'block' : 'none'; if (!on) cliprect.style.display = 'none'; };
  const drawClip = (a: { x: number; y: number }, b: { x: number; y: number }): void => {
    const r = rectFromPoints(a, b);
    cliprect.style.left = `${r.x}px`; cliprect.style.top = `${r.y}px`;
    cliprect.style.width = `${r.width}px`; cliprect.style.height = `${r.height}px`;
    cliprect.style.display = 'block';
  };

  const attachHost = (): void => { (document.documentElement || document.body).appendChild(host); };
  if (document.documentElement) attachHost();
  else document.addEventListener('DOMContentLoaded', attachHost, { once: true });

  const showHover = (on: boolean): void => { outline.style.display = whisker.style.display = on ? 'block' : 'none'; };

  const drawFor = (el: Element): void => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    outline.classList.remove('marked');
    outline.style.borderRadius = cs.borderRadius && cs.borderRadius !== '0px' ? cs.borderRadius : '6px';
    outline.style.left = `${r.left - 2}px`;
    outline.style.top = `${r.top - 2}px`;
    outline.style.width = `${r.width}px`;
    outline.style.height = `${r.height}px`;
    whisker.textContent = whiskerLabel(el);
    whisker.style.left = `${r.left}px`;
    whisker.style.top = `${Math.max(2, r.top - 20)}px`;
  };

  const arm = (): void => { mode = 'hover'; showHover(false); };
  const disarm = (): void => { mode = 'idle'; armedByAlt = false; current = null; showHover(false); bar.style.display = 'none'; setClip(false); };

  const onMove = (e: MouseEvent): void => {
    if (clipMode && clipStart) { drawClip(clipStart, { x: e.clientX, y: e.clientY }); return; }
    if (mode !== 'hover') return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || (el as Element).closest('[data-wigolo-overlay]')) return; // never target our own chrome
    current = el;
    showHover(true);
    drawFor(el);
  };

  const onWheel = (e: WheelEvent): void => {
    if (mode !== 'hover' || !current) return;
    if (e.deltaY < 0) { // scroll up → climb to the ancestor (grab the card, not the span)
      e.preventDefault();
      current = ancestorWalk(current, 'up');
      drawFor(current);
    }
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    // ⌘⇧C — capture the current text selection as a cited quote (independent of hover/mark mode, §4 State 4).
    if (e.metaKey && e.shiftKey && (e.key === 'C' || e.key === 'c')) {
      const sel = window.getSelection();
      const q = serializeQuote({ text: sel?.toString() ?? '', anchorNode: sel?.anchorNode ?? null }, location.href);
      if (q) { e.preventDefault(); ipcRenderer.send(CH.quote, q); }
      return;
    }
    // ⌘⇧X — arm region clip; the next drag draws a rectangle → screenshot artifact (§4 State 4).
    if (e.metaKey && e.shiftKey && (e.key === 'X' || e.key === 'x')) { e.preventDefault(); setClip(!clipMode); return; }
    if (e.key === 'Escape' && clipMode) { setClip(false); return; }
    if (e.key === 'Alt' && mode === 'idle') { armedByAlt = true; arm(); return; }
    if (e.key === 'Escape' && mode !== 'idle') { disarm(); return; }
    if (e.shiftKey && e.key === 'ArrowUp' && mode === 'hover' && current) {
      e.preventDefault();
      current = ancestorWalk(current, 'up');
      drawFor(current);
    }
  };
  const onKeyUp = (e: KeyboardEvent): void => { if (e.key === 'Alt' && armedByAlt) disarm(); };

  // The page must see NONE of the marking gesture — not just the synthetic `click`. A real click fires
  // pointerdown→mousedown→pointerup→mouseup→click; a page that side-effects on a PRESS event (mousedown
  // navigation, pointerdown analytics/drag) would otherwise run from a pure marking gesture. Swallow the
  // whole sequence in capture phase while armed; the browser still generates `click` (default-prevented
  // press events do not cancel it), so `commit` below still fires to create the mark.
  const swallowPress = (e: Event): void => {
    // Region clip owns the drag while armed: record the start on press, commit the rect on release, and
    // keep the page from seeing (or drag-selecting) any of it.
    if (clipMode) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const me = e as MouseEvent;
      if (e.type === 'mousedown') { clipStart = { x: me.clientX, y: me.clientY }; }
      else if (e.type === 'mouseup' && clipStart) {
        const rect = rectFromPoints(clipStart, { x: me.clientX, y: me.clientY });
        setClip(false);
        if (rect.width > 4 && rect.height > 4) ipcRenderer.send(CH.region, { rect }); // ignore an accidental click (no drag)
      }
      return;
    }
    if (mode !== 'hover') return;
    e.preventDefault();
    e.stopImmediatePropagation();
  };

  const commit = (e: MouseEvent): void => {
    if (mode !== 'hover' || !current) return;
    // capture-phase; stopImmediatePropagation blocks same-node/sibling capture listeners too (this preload
    // registers before page scripts, so it is first). Together with swallowPress the page sees no marking input.
    e.preventDefault();
    e.stopImmediatePropagation();
    if (current.getRootNode() instanceof ShadowRoot) { // shadow-internal pick — the path bridge can't express it
      whisker.textContent = "can't mark inside a component boundary";
      return; // stay in hover; no mark sent
    }
    const target = current;
    const nonce = (globalThis.crypto?.randomUUID?.() ?? `n${++markSeq}-${Date.now()}`);
    const msg: OverlayMarkMsg = { nonce, path: elementPath(target), payload: serializePayload(target) };
    ipcRenderer.send(CH.mark, msg);

    mode = 'marked';
    const r = target.getBoundingClientRect();
    outline.classList.add('marked');
    // provisional chip (spinner dot until the main echo assigns a number)
    const chip = document.createElement('div');
    chip.className = 'chip';
    chip.textContent = '◈ …';
    chip.style.left = `${r.left}px`;
    chip.style.top = `${r.top}px`;
    chips.appendChild(chip);
    pendingChips.set(nonce, chip);
    // bloom the action bar ~3s
    bar.style.left = `${r.left}px`;
    bar.style.top = `${r.bottom + 6}px`;
    bar.style.display = 'flex';
    window.setTimeout(() => { bar.style.display = 'none'; }, 3000);
  };

  bar.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('button');
    if (!btn) return;
    const act = btn.getAttribute('data-act');
    if (act === 'grab' && activeMarkId) ipcRenderer.send(CH.generalize, { markId: activeMarkId });
    // comment/watch/send: the comment flow lives in the Marks panel; watch=P7, send=P4 (disabled).
  });

  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('wheel', onWheel, { capture: true, passive: false });
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('keyup', onKeyUp, true);
  for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'dblclick', 'contextmenu']) {
    document.addEventListener(t, swallowPress, true);
  }
  document.addEventListener('click', commit, true);

  // P4 ghost cursor: the agent's act broadcasts its resolved target point + narration caption here. Renders
  // the violet cursor + caption in this isolated-world overlay (renderer chrome DOM sits behind the page),
  // and fades after the act settles. Caption is agent-authored narration — never page-derived content.
  ipcRenderer.on(CH.cursor, (_e, m: { x: number; y: number; caption: string }) => {
    const p = ghostCursorPlacement(m, { w: window.innerWidth, h: window.innerHeight });
    ghost.style.left = `${p.cursor.left}px`; ghost.style.top = `${p.cursor.top}px`; ghost.style.display = 'block';
    if (m.caption) { ghostcap.textContent = m.caption; ghostcap.style.left = `${p.caption.left}px`; ghostcap.style.top = `${p.caption.top}px`; ghostcap.style.display = 'block'; }
    else ghostcap.style.display = 'none';
    window.clearTimeout(ghostTimer);
    ghostTimer = window.setTimeout(() => { ghost.style.display = 'none'; ghostcap.style.display = 'none'; }, 1800);
  });

  ipcRenderer.on(CH.arm, () => arm());
  // P4 toolbar ✂ → arm region clip (same as the ⌘⇧X keyboard arm; the next drag draws the rectangle).
  ipcRenderer.on(CH.clipArm, () => setClip(true));
  ipcRenderer.on(CH.assigned, (_e, data: { nonce: string; markId: string; number: number }) => {
    const chip = pendingChips.get(data.nonce);
    if (chip) { chip.textContent = `◈ ${data.number}`; pendingChips.delete(data.nonce); }
    activeMarkId = data.markId; // the action bar's ⧉ now targets this mark
  });
}
