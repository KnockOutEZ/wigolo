/**
 * Pin 8's fourth lesson — LARGE OUTPUT GOES TO A FILE, and the result inlines an excerpt
 * plus the path.
 *
 * The rule is an MCP-surface rule, not a studio one: any tool whose payload can outgrow a
 * context window owes the caller (a) enough inline to keep working and (b) the file to read
 * when the excerpt is not enough. It lives here, beside the tool schemas, because that is the
 * layer the rule is about.
 *
 * Law 11 (local and inspectable) is why the PATH is returned and not only an opaque handle:
 * the existing snapshot spill already writes the full payload to disk, but it hands back a
 * `spill:<hash>` ref alone, so a user who wants to see what left their machine has nothing to
 * open. A ref is a retrieval token; a path is inspectability. Both ride the result.
 *
 * Run attribution (law 1: the run is the unit of everything) puts each file under its run's
 * own directory, so a run's artefacts can be listed, shown, and swept as a unit. A caller with
 * no run id yet writes under `unattributed` rather than silently sharing a pool — the gap is
 * visible in the path instead of being invisible in a flat directory.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { studioStateDir } from '../companion/paths.js';

/** The directory segment a run's oversized tool output is written beneath. */
const OUTPUT_SEGMENT = 'output';
/** Path segment used when the caller has no run id — visible, never silently pooled. */
const UNATTRIBUTED = 'unattributed';

/** A run id is a path segment; anything outside this set is replaced so a hostile id cannot traverse. */
function safeSegment(runId: string | undefined): string {
  if (!runId) return UNATTRIBUTED;
  const cleaned = runId.replace(/[^A-Za-z0-9_-]/g, '');
  return cleaned.length > 0 ? cleaned.slice(0, 64) : UNATTRIBUTED;
}

export interface LargeOutputFile {
  /** Absolute path to the full payload on disk — the law-11 half of the contract. */
  file: string;
  /** Bytes written, so the caller can say how much it is NOT inlining. */
  bytes: number;
}

/**
 * Write `payload` as JSON under the run's output directory and return its path. Content-addressed
 * within the run, so re-writing the same payload is idempotent rather than an ever-growing pile.
 */
export function writeLargeOutput(payload: unknown, opts: { dataDir?: string; runId?: string; kind: string }): LargeOutputFile {
  const json = JSON.stringify(payload, null, 2);
  const digest = createHash('sha256').update(json).digest('hex').slice(0, 16);
  const dir = studioStateDir(opts.dataDir, 'runs', safeSegment(opts.runId), OUTPUT_SEGMENT);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${opts.kind}-${digest}.json`);
  writeFileSync(file, json, { mode: 0o600 });
  return { file, bytes: Buffer.byteLength(json) };
}

export interface Excerpted<T> {
  /** The inline excerpt — the head of the set, always present even when the rest went to disk. */
  inline: T[];
  /** How many entries are ONLY in the file. Zero ⇒ the excerpt is the whole set and no file was written. */
  spilled: number;
  /** Absolute path to the full set; absent when nothing spilled. */
  file?: string;
  /** Bytes of the full set on disk; absent when nothing spilled. */
  bytes?: number;
}

/**
 * Apply the rule to an array: keep the first `limit` entries inline, and when there are more,
 * write the WHOLE set (not the tail) to disk so the file is a complete artefact on its own —
 * a reader should never have to stitch an excerpt and a remainder back together.
 */
export function excerptToFile<T>(
  items: readonly T[],
  limit: number,
  opts: { dataDir?: string; runId?: string; kind: string },
): Excerpted<T> {
  if (items.length <= limit) return { inline: [...items], spilled: 0 };
  const written = writeLargeOutput(items, opts);
  return { inline: items.slice(0, limit), spilled: items.length - limit, file: written.file, bytes: written.bytes };
}
