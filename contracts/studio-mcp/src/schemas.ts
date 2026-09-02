import { type StudioToolName } from './tool-names.js';

/**
 * THE TEN `studio_*` INPUT SCHEMAS, OWNED HERE.
 *
 * ── Why a copy and not a re-export ──────────────────────────────────────────────────────────────
 *
 * These same objects exist in core at `src/server/tool-schemas.ts`. This package could import them,
 * and that would be less code. It would also mean there is no contract: if the artifact that DEFINES
 * the wire is the same object the implementation SERVES, then any implementation-side edit silently
 * redefines the contract and nothing can ever be found to have broken it. "The implementation matches
 * itself" is not a check.
 *
 * A contract also has to be statable without the implementation present. After a repo split this
 * package cannot import `../../src/...` at all, so a re-export would make the split a refactor — the
 * exact cost this package exists to remove.
 *
 * The obvious hazard of a copy is silent drift, and drift is worse than no contract because it reads
 * as a passing gate. So the copy is not left to discipline: `tests/schema-drift.test.ts` asserts
 * per-tool strict equality against core's own exported schema objects AND compares the two name sets
 * in both directions, so a core-side edit that does not update this file reds — and so does a tool
 * added on one side only. That test is the only place in this package that imports core, and it is
 * the one place where importing core is the point.
 *
 * ── What "the same" means here ──────────────────────────────────────────────────────────────────
 *
 * Strict equality, descriptions included. The descriptions are not decoration: they are the entire
 * instruction an agent gets about a parameter's safety semantics (`studio_act.url` states that
 * cloud-internal is always blocked and private needs a human grant), so a reworded description is a
 * change to what agents are told and belongs in a contract diff.
 *
 * `additionalProperties` is present on seven of the ten and absent on three. That asymmetry is
 * copied exactly rather than normalized: it is a client-side hint, never the boundary control (the
 * host handler reads only the fields it needs), and normalizing it here would make the contract
 * disagree with the wire for no gain.
 */
export type StudioToolSchema = {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
};

const STUDIO_OBSERVE: StudioToolSchema = {
  type: 'object',
  properties: {
    since: {
      type: 'number',
      description: 'Event cursor from your last observe; pass it back to receive only newer human events and acknowledge the prior ones.',
    },
    base_id: {
      type: 'string',
      description: 'The page-snapshot id you currently hold; on a mismatch (reconnect or navigation) you get a fresh full snapshot instead of a diff.',
    },
    snapshot_ref: {
      type: 'string',
      description: 'Fetch a previously spilled (oversized) snapshot by its reference.',
    },
    narration: {
      type: 'string',
      description: 'Optional short note shown to the watching human (e.g. why you are reading the page now). Display-only and shown as inert text; it is not a command and is never stored.',
    },
    find: {
      type: 'string',
      description: 'Grep the live page: the elements whose role or name matches are named in `found`, with their refs. Case-insensitive substring by default. Additive — it points you at the match instead of making you scan the snapshot yourself.',
    },
    find_regex: {
      type: 'boolean',
      description: 'Treat `find` as a regular expression instead of literal text. A pattern that does not compile is refused, never silently matched as text.',
    },
  },
  required: [],
};

const STUDIO_ACT: StudioToolSchema = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['navigate', 'click', 'type', 'scroll'],
      description: 'What to do in the shared browser session: navigate to a URL, click an element, type text into an element, or scroll the page.',
    },
    url: {
      type: 'string',
      description: 'For navigate: the URL to open. Must be http(s); cloud-internal addresses are always blocked, and private/local addresses are blocked unless the human has granted it for this session.',
    },
    ref: {
      type: 'string',
      description: 'For click/type: the stable element ref from studio_observe. Resolved live at action time — a stale, ambiguous, or covered ref is refused (re-observe) rather than acting on the wrong element.',
    },
    text: {
      type: 'string',
      description: 'For type: the text to type into the element (it is focused first).',
    },
    direction: {
      type: 'string',
      enum: ['down', 'up'],
      description: 'For scroll: the direction to scroll (default down).',
    },
    amount: {
      type: 'number',
      description: 'For scroll: distance in page pixels (default 600).',
    },
    narration: {
      type: 'string',
      description: 'Optional short note shown to the watching human alongside this action (e.g. why you are clicking it). Display-only and shown as inert text; it is not a command and is never stored.',
    },
    post_actions: {
      type: 'boolean',
      description: 'Default true: the result also reports what the page became and what the console said. Set false when you already know, to get the smaller result.',
    },
  },
  required: ['action'],
};

const STUDIO_MARKS: StudioToolSchema = {
  type: 'object',
  properties: {
    op: {
      type: 'string',
      enum: ['list', 'generalize'],
      description: "Omit (or 'list') to read all marks; 'generalize' previews the repeating set a mark belongs to.",
    },
    markId: {
      type: 'string',
      description: "The mark to generalize (required when op='generalize').",
    },
  },
  required: [],
};

const STUDIO_CAPTURE: StudioToolSchema = {
  type: 'object',
  properties: {
    type: {
      type: 'string',
      enum: ['clip', 'qa'],
      description: "What to capture. 'clip' saves a page region (needs content + url); 'qa' saves a question + answer pair from the session (url-less).",
    },
    content: {
      type: 'string',
      description: 'The content to save (clip only — the text/markdown).',
    },
    url: {
      type: 'string',
      description: 'The page url the clip was captured from (clip only).',
    },
    question: {
      type: 'string',
      description: 'The question (qa only).',
    },
    answer: {
      type: 'string',
      description: 'The answer (qa only).',
    },
  },
  required: ['type'],
  additionalProperties: false,
};

const STUDIO_SAY: StudioToolSchema = {
  type: 'object',
  properties: {
    text: {
      type: 'string',
      description: 'The message to post to the human in the session chat rail.',
    },
    markId: {
      type: 'string',
      description: 'Optional mark id (from studio_marks) to thread the reply under.',
    },
  },
  required: ['text'],
  additionalProperties: false,
};

const STUDIO_EXTRACT_SET: StudioToolSchema = {
  type: 'object',
  properties: {
    mark_id: { type: 'string', description: 'The mark (from studio_marks) whose repeating set to extract into rows.' },
    tab_id: { type: 'string', description: 'Optional — the session tab that owns the mark. Defaults to the active session; a tab_id from another session is refused.' },
    exclude_refs: { type: 'array', items: { type: 'string' }, description: 'Refs from the matched set to drop before extracting.' },
    follow_pagination: { type: 'boolean', description: 'Follow a same-site next-page control and accumulate rows (bounded, gated).' },
    max_pages: { type: 'number', description: 'Max pages to follow (clamped to a host ceiling).' },
    max_rows: { type: 'number', description: 'Max rows to collect (clamped to a host ceiling).' },
  },
  required: ['mark_id'],
  additionalProperties: false,
};

const STUDIO_SPAWN: StudioToolSchema = {
  type: 'object',
  properties: {
    startUrl: {
      type: 'string',
      description: 'Optional URL the new background session should open first. Subject to the same navigation safety as studio_act.',
    },
  },
  required: [],
  additionalProperties: false,
};

const STUDIO_OPEN: StudioToolSchema = {
  type: 'object',
  properties: {
    name: {
      type: 'string',
      description: 'Optional friendly name for the session (shown in the workspace session switcher).',
    },
    startUrl: {
      type: 'string',
      description: 'Optional URL the session should open first. Subject to the same navigation safety as studio_act.',
    },
  },
  required: [],
  additionalProperties: false,
};

const STUDIO_CLOSE: StudioToolSchema = {
  type: 'object',
  properties: {
    session_id: {
      type: 'string',
      description: 'The id of the session to close (from studio_open, studio_spawn, or studio_list).',
    },
  },
  required: ['session_id'],
  additionalProperties: false,
};

const STUDIO_LIST: StudioToolSchema = {
  type: 'object',
  properties: {},
  required: [],
  additionalProperties: false,
};

/**
 * Keyed by wire name, and typed `Record<StudioToolName, …>` so adding a name to `STUDIO_TOOL_NAMES`
 * fails the compile here until its schema exists — the same compile-enforced pairing core gets from
 * `TOOL_SCHEMAS: Record<ToolName, ToolSchema>`.
 */
export const STUDIO_TOOL_SCHEMAS: Record<StudioToolName, StudioToolSchema> = {
  studio_act: STUDIO_ACT,
  studio_capture: STUDIO_CAPTURE,
  studio_close: STUDIO_CLOSE,
  studio_extract_set: STUDIO_EXTRACT_SET,
  studio_list: STUDIO_LIST,
  studio_marks: STUDIO_MARKS,
  studio_observe: STUDIO_OBSERVE,
  studio_open: STUDIO_OPEN,
  studio_say: STUDIO_SAY,
  studio_spawn: STUDIO_SPAWN,
};
