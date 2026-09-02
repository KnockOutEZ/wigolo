/**
 * The §4.4 result footer — law 9 ("tool results are UI") made literal.
 *
 * No plugin is required to drive wigolo's studio surface, so for a terminal user the TEXT a tool
 * returns *is* the interface. §4.4 designs that text: which run this was, who drives it, how many
 * tabs it owns, what a human said, whether the page moved under the agent, what is blocking, and
 * what it has cost so far — on every result, of every verb, on every transport.
 *
 * TWO BLOCKS, NOT ONE (mini-spec §4.1, A-51-2). Every studio result is one text block of
 * pretty-printed JSON that consumers parse. Appending prose inside it would break them; hiding the
 * footer in a JSON field would make it machine data a terminal harness may never render, which is
 * exactly what law 9 forbids. So the footer is a SECOND text block: `content[0]` stays
 * byte-for-byte what it was, `content[1]` is real rendered text an MCP client shows in order.
 *
 * EVERY FIELD IS A PROJECTION. Nothing here counts anything. The run id, driver badge, tab count,
 * pending decision and cost are read off the run log's projection; the delivered-message count is
 * the log's `message.delivered` rows for this call. There is deliberately no counter, cache or
 * tally in this module — a second tally would be a second source of truth (law 1).
 *
 * PHRASING, NEVER CONTENT (§4.2, law 5). The detected client selects the wording of the two
 * imperatives and nothing else: same fields, same values, same order, same numbers for everyone.
 * A client that is not in the table gets the tool-agnostic register and is not degraded by it.
 *
 * Capability language throughout: "browser engine", never the engine's name.
 */
import type { PhrasingKey } from './capability-handshake.js';
import { PAGE_CHANGED_BY_HUMAN } from '../studio/perception/held-snapshot.js';
import type { McpToolResult } from '../server/tool-registry.js';

/** The SD1 watch-link form — the same short run id the header line carries. */
export const WATCH_LINK_PREFIX = 'wigolo.studio/r/';

export function watchLink(runId: string): string {
  return `${WATCH_LINK_PREFIX}${runId}`;
}

/**
 * The header line when a result is minted before any run exists (§4.1's one exception: an unknown
 * tool name, a refusal from the stdio side that never reached a host). The conditional lines and
 * the cost line are absent rather than zeroed — there is no run to have spent anything, and a
 * fabricated `$0.00 · watch: …/undefined` would be worse than silence (#56 AC: never a fabricated
 * number).
 */
export const NO_RUN_FOOTER = '— no run —';

/**
 * What the footer renders. Every field is supplied by a projection of the run log; this module
 * neither reads a store nor holds state, which is what keeps it loadable in the Electron main
 * (`studio-mcp-server.ts` — better-sqlite3 cannot load there).
 */
export interface FooterFields {
  /** `Run.id`. Absent ⇒ the whole footer is `NO_RUN_FOOTER`. */
  runId?: string;
  /** `formatDriver(Run.driver)` — the ONE driver string, identical in REST, on the event stream and here. */
  driverName?: string;
  /** `Run.tabIds.length` (law 4: a run owns ≥1 tab; a tab belongs to exactly one run). */
  tabs?: number;
  /** Messages THIS result delivers — the `message.delivered` rows this call appended. Rendered only when > 0. */
  humanMessages?: number;
  /** A `snapshot.invalidated` newer than the driver's last read (§5). Rendered only when true. */
  pageChanged?: boolean;
  /** The oldest unanswered, unexpired `PendingDecision`'s prompt. Rendered only when one blocks. */
  approval?: string;
  /** A failing site-profile assertion (SD6 writes them; the slot is reserved so the grammar cannot change later). */
  assertionFailed?: string;
  /** Recorded BYOK spend, in USD. `0` renders `$0.00` — the honest answer when nothing is recorded. */
  spendUsd?: number;
  /** Recorded browser actions. Named in the render, so the line states what it counts. */
  browserActions?: number;
}

/**
 * The two imperatives phrasing is allowed to reword (§4.2). `mcp-tools` names the tools the client
 * actually has; `generic` says the same thing without naming a tool it may not have. Both quote
 * `PAGE_CHANGED_BY_HUMAN` verbatim — §7 row 1's exact words are the contract, the tail is not.
 */
const REREAD: Readonly<Record<PhrasingKey, string>> = {
  'mcp-tools': 'with studio_observe',
  generic: 'the page',
};

const RESOLVE: Readonly<Record<PhrasingKey, string>> = {
  'mcp-tools': 'resolve from the panel, or answer here',
  generic: 'resolve from any surface, or answer here',
};

/**
 * The grammar a reader (and the #56 coverage test) recognises a footer block by. Anchored at the
 * start so a footer can never be confused with the JSON block, which always begins `{`.
 */
export const FOOTER_HEADER_PATTERN = /^— (?:run \S+ · driver .+ · tab \d+ —|no run —)$/;

/** Is this block the footer? Used to REPLACE rather than stack when a result is re-rendered. */
export function isFooterBlock(block: { type: string; text?: string } | undefined): boolean {
  if (!block || block.type !== 'text' || typeof block.text !== 'string') return false;
  const [first] = block.text.split('\n');
  return first !== undefined && FOOTER_HEADER_PATTERN.test(first);
}

/** Money, always two decimals — `$0.00` when nothing has been recorded, never a guess. */
function usd(value: number | undefined): string {
  const amount = typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
  return `$${amount.toFixed(2)}`;
}

function count(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * Render §4.2's template. Four lines are conditional — `human msgs` only when > 0, `page changed`
 * only when yes, `approval` only when one blocks, `assertion failed` only when one fails — because
 * a permanent `no` line spends the agent's context on noise and teaches it to skip the line that
 * matters (A-51-6).
 */
export function renderFooter(fields: FooterFields, phrasing: PhrasingKey = 'generic'): string {
  const runId = fields.runId?.trim();
  if (!runId) return NO_RUN_FOOTER;

  const driver = fields.driverName?.trim() || 'unknown';
  const lines = [`— run ${runId} · driver ${driver} · tab ${count(fields.tabs)} —`];

  const msgs = count(fields.humanMessages);
  if (msgs > 0) lines.push(`  human msgs: ${msgs}`);
  if (fields.pageChanged) lines.push(`  page changed: yes — ${PAGE_CHANGED_BY_HUMAN} ${REREAD[phrasing]}`);
  if (fields.approval) lines.push(`  approval: ${oneLine(fields.approval)} — ${RESOLVE[phrasing]}`);
  if (fields.assertionFailed) lines.push(`  assertion failed: ${oneLine(fields.assertionFailed)}`);

  // The units are named rather than implied: pre-SD6 this line counts recorded BYOK spend and
  // browser actions, and token spend lands when SD6's ledger records it. Saying "browser actions"
  // is what makes the number's meaning readable without a changelog (#56 AC).
  lines.push(`  cost so far: ${usd(fields.spendUsd)} · ${count(fields.browserActions)} browser actions · watch: ${watchLink(runId)}`);
  return lines.join('\n');
}

/** A prompt is human-authored and may be multi-line; the footer is line-oriented, so flatten it. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Attach the footer to a minted result — REPLACING an existing footer block rather than stacking a
 * second one, so a result can be re-rendered after the delivery queue has ridden it (the message
 * count is only knowable then) without the agent seeing the footer twice.
 *
 * `content[0]` is never touched: it is the block every studio consumer parses.
 */
export function applyFooter(result: McpToolResult, footer: string): McpToolResult {
  const block = { type: 'text' as const, text: footer };
  const rest = result.content.slice(1);
  const tail = isFooterBlock(rest[0]) ? rest.slice(1) : rest;
  return { ...result, content: [result.content[0], block, ...tail].filter((b) => b !== undefined) };
}
