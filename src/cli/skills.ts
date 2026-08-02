import {
  planSkills,
  applySkillsPlan,
  listSkills,
  removeSkills,
  planRemove,
  SUPPORTED_AGENTS,
  listPackNames,
} from './agents/skills/index.js';
import type {
  ApplyResult,
  ListEntry,
  PlanAction,
  Scope,
  SkillsPlan,
} from './agents/skills/index.js';
import { agentHandlers, detectInstalledHandlers } from './agents/registry.js';

const USAGE = [
  'Usage: wigolo skills <subcommand> [packs...] [options]',
  '',
  'Subcommands:',
  '  add [pack ...]     Install skill packs for your coding agents',
  '  list [pack ...]    Show install state per agent',
  '  remove [pack ...]  Remove installed skill packs',
  '',
  'Options:',
  '  --global           Install/remove at user scope (default: project/cwd)',
  '  --agent <id,...>   Target specific agents (default: detected agents)',
  '  --dry-run          Show the plan without touching the filesystem',
  '  --json             Emit machine-readable JSON',
  '  --force            Overwrite user-modified files / replace symlinks',
  '',
  'Examples:',
  '  wigolo skills add',
  '  wigolo skills add wigolo-search --agent claude-code,cursor',
  '  wigolo skills list --global',
  '  wigolo skills remove --dry-run',
].join('\n');

type Subcommand = 'add' | 'list' | 'remove';
const SUBCOMMANDS: ReadonlySet<string> = new Set(['add', 'list', 'remove']);

function writeOut(line: string): void {
  process.stdout.write(`${line}\n`);
}

function writeErr(line: string): void {
  process.stderr.write(`${line}\n`);
}

/** A single machine-readable action row in the --json envelope. */
interface JsonAction {
  agents: string[];
  packs: string[];
  path: string;
  status: string;
  reason?: string;
}

/**
 * The --json envelope, emitted on EVERY exit path (success, no-op, usage error,
 * refusal). `status` mirrors the exit code family: 'ok' → 0, 'error' → 1|2.
 */
interface SkillsJson {
  status: 'ok' | 'error';
  scope: Scope;
  actions: JsonAction[];
  summary: string;
}

function emitJson(env: SkillsJson): void {
  process.stdout.write(`${JSON.stringify(env)}\n`);
}

interface ParsedArgs {
  sub?: string;
  packs: string[];
  global: boolean;
  agents: string[];
  dryRun: boolean;
  json: boolean;
  force: boolean;
  help: boolean;
}

class SkillsArgError extends Error {}

/** Parse skills-subcommand argv. Throws SkillsArgError on malformed flags. */
function parseArgs(args: string[]): ParsedArgs {
  const out: ParsedArgs = {
    packs: [],
    global: false,
    agents: [],
    dryRun: false,
    json: false,
    force: false,
    help: false,
  };
  let i = 0;
  // First non-flag token is the subcommand.
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === '-h' || a === '--help') {
      out.help = true;
      return out;
    }
    if (a.startsWith('-')) {
      // A flag appeared before any subcommand — malformed.
      throw new SkillsArgError(`missing subcommand before flag: ${a}`);
    }
    out.sub = a;
    i++;
    break;
  }

  for (; i < args.length; i++) {
    const a = args[i];
    if (a === '-h' || a === '--help') {
      out.help = true;
    } else if (a === '--global') {
      out.global = true;
    } else if (a === '--dry-run') {
      out.dryRun = true;
    } else if (a === '--json') {
      out.json = true;
    } else if (a === '--force') {
      out.force = true;
    } else if (a === '--agent' || a === '--agents') {
      const val = args[i + 1];
      if (!val || val.startsWith('-')) {
        throw new SkillsArgError(`${a} requires a value (comma-separated agent ids)`);
      }
      out.agents.push(...splitCsv(val));
      i++;
    } else if (a.startsWith('--agent=') || a.startsWith('--agents=')) {
      out.agents.push(...splitCsv(a.slice(a.indexOf('=') + 1)));
    } else if (a.startsWith('-')) {
      throw new SkillsArgError(`unknown flag: ${a}`);
    } else {
      out.packs.push(a);
    }
  }
  return out;
}

function splitCsv(s: string): string[] {
  return s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

/** Agent ids the agent registry knows but that carry no skills target. */
function noSkillsAgentIds(): Set<string> {
  const supported = new Set<string>(SUPPORTED_AGENTS);
  return new Set(agentHandlers.map((h) => h.id).filter((id) => !supported.has(id)));
}

const SUPPORTED_LIST = [...SUPPORTED_AGENTS].join(', ');

/**
 * `wigolo skills` — install / list / remove skill packs across coding agents.
 * Thin: parses argv, resolves scope + agents + packs, delegates to the engine
 * (planSkills / applySkillsPlan / listSkills / removeSkills), renders, and maps
 * exit codes: 0 success/no-op, 1 execution failure, 2 usage/refusal.
 */
export async function runSkills(args: string[]): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(args);
  } catch (err) {
    const msg = err instanceof SkillsArgError ? err.message : String(err);
    writeErr(msg);
    writeErr(USAGE);
    if (argvWantsJson(args)) {
      emitJson({ status: 'error', scope: 'project', actions: [], summary: msg });
    }
    return 2;
  }

  const scope: Scope = parsed.global ? 'global' : 'project';

  if (parsed.help) {
    // Under --json, keep stdout to the single JSON document (usage → stderr).
    if (parsed.json) {
      writeErr(USAGE);
      emitJson({ status: 'ok', scope, actions: [], summary: 'usage' });
    } else {
      writeOut(USAGE);
    }
    return 0;
  }

  if (!parsed.sub) {
    writeErr('Missing subcommand.');
    writeErr(USAGE);
    if (parsed.json) emitJson({ status: 'error', scope, actions: [], summary: 'missing subcommand' });
    return 2;
  }
  if (!SUBCOMMANDS.has(parsed.sub)) {
    const msg = `Unknown subcommand: ${parsed.sub}`;
    writeErr(msg);
    writeErr(USAGE);
    if (parsed.json) emitJson({ status: 'error', scope, actions: [], summary: msg });
    return 2;
  }
  const sub = parsed.sub as Subcommand;

  // Validate --agent ids against the skills-capable set. Registered-but-no-skills
  // ids (vscode/zed/antigravity/opencode) and unknown ids both reject with the
  // supported list — but only on add/remove. list tolerates them (rows them as
  // "not supported").
  const supportedSet = new Set<string>(SUPPORTED_AGENTS);
  if (parsed.agents.length && sub !== 'list') {
    const bad = parsed.agents.filter((a) => !supportedSet.has(a));
    if (bad.length) {
      const msg = `Unsupported agent(s): ${bad.join(', ')} — supported: ${SUPPORTED_LIST}`;
      writeErr(msg);
      if (parsed.json) emitJson({ status: 'error', scope, actions: [], summary: msg });
      return 2;
    }
  }

  // Validate packs against the catalog.
  if (parsed.packs.length) {
    const known = new Set(listPackNames());
    const unknown = parsed.packs.filter((p) => !known.has(p));
    if (unknown.length) {
      const valid = [...known].sort().join(', ');
      const msg = `Unknown pack(s): ${unknown.join(', ')} — valid packs: ${valid}`;
      writeErr(msg);
      if (parsed.json) emitJson({ status: 'error', scope, actions: [], summary: msg });
      return 2;
    }
  }

  if (sub === 'list') {
    return runList(parsed, scope);
  }
  return runAddOrRemove(sub, parsed, scope);
}

/** Resolve the agent set to operate on for add/remove (named or detected). */
function resolveAgents(parsed: ParsedArgs): { agents: string[]; detectedNote?: string } {
  if (parsed.agents.length) {
    return { agents: parsed.agents };
  }
  // No --agent → all DETECTED skills-capable agents (agent-registry detect).
  const supportedSet = new Set<string>(SUPPORTED_AGENTS);
  const detected = detectInstalledHandlers()
    .map((h) => h.id)
    .filter((id) => supportedSet.has(id));
  if (detected.length === 0) {
    return {
      agents: [],
      detectedNote:
        'No supported coding agents detected in this environment. ' +
        `Pass --agent <id,...> to target one explicitly (supported: ${SUPPORTED_LIST}).`,
    };
  }
  return { agents: detected };
}

function actionToJson(a: PlanAction): JsonAction {
  return {
    agents: a.agents,
    packs: a.packs,
    path: a.relPath ?? a.path,
    status: a.status,
    ...(a.reason ? { reason: a.reason } : {}),
  };
}

async function runAddOrRemove(
  sub: 'add' | 'remove',
  parsed: ParsedArgs,
  scope: Scope,
): Promise<number> {
  const cwd = process.cwd();
  const { agents, detectedNote } = resolveAgents(parsed);

  // None detected (and none named) — actionable no-op, NOT an error.
  if (agents.length === 0) {
    writeErr(detectedNote ?? 'No agents to target.');
    if (parsed.json) {
      emitJson({ status: 'ok', scope, actions: [], summary: 'no agents detected — nothing to do' });
    }
    return 0;
  }

  const packs = parsed.packs.length ? parsed.packs : undefined;

  if (sub === 'add') {
    let plan: SkillsPlan;
    try {
      plan = planSkills({ packs, scope, agents, cwd, force: parsed.force });
    } catch (err) {
      return failExec(err, scope, parsed.json);
    }

    if (parsed.dryRun) {
      // Under --json the JSON document is the ONLY thing on stdout.
      if (parsed.json) emitPlanJson(plan, scope);
      else renderPlan(plan, { dryRun: true });
      return planHasRefusal(plan) ? 2 : 0;
    }

    let result: ApplyResult;
    try {
      result = applySkillsPlan(plan);
    } catch (err) {
      return failExec(err, scope, parsed.json);
    }
    if (parsed.json) emitApplyJson(plan, result, scope);
    else renderApply(plan, result);
    return result.refused.length ? 2 : 0;
  }

  // remove
  if (parsed.dryRun) {
    // Pure preview via the engine — same remove/refuse/notice action list, no
    // fs or receipt mutation.
    let plan: SkillsPlan;
    try {
      plan = planRemove({ packs, scope, agents, cwd, force: parsed.force });
    } catch (err) {
      return failExec(err, scope, parsed.json);
    }
    if (parsed.json) emitPlanJson(plan, scope);
    else renderPlan(plan, { dryRun: true });
    return planHasRefusal(plan) ? 2 : 0;
  }

  let result: ApplyResult;
  try {
    result = removeSkills({ packs, scope, agents, cwd, force: parsed.force });
  } catch (err) {
    return failExec(err, scope, parsed.json);
  }
  if (parsed.json) emitRemoveJson(result, scope);
  else renderRemove(result);
  return result.refused.length ? 2 : 0;
}

function runList(parsed: ParsedArgs, scope: Scope): number {
  const cwd = process.cwd();
  const noSkills = noSkillsAgentIds();

  // For list, --agent may include registered-no-skills ids (rowed as "not
  // supported") but truly unknown ids still reject.
  let agentArg: string[] | undefined;
  const notSupportedRows: string[] = [];
  if (parsed.agents.length) {
    const supportedSet = new Set<string>(SUPPORTED_AGENTS);
    const unknown = parsed.agents.filter((a) => !supportedSet.has(a) && !noSkills.has(a));
    if (unknown.length) {
      const msg = `Unknown agent(s): ${unknown.join(', ')} — supported: ${SUPPORTED_LIST}`;
      writeErr(msg);
      if (parsed.json) emitJson({ status: 'error', scope, actions: [], summary: msg });
      return 2;
    }
    for (const a of parsed.agents) {
      if (noSkills.has(a)) notSupportedRows.push(a);
    }
    agentArg = parsed.agents.filter((a) => supportedSet.has(a));
  }

  const packs = parsed.packs.length ? parsed.packs : undefined;
  let entries: ListEntry[];
  try {
    entries = listSkills({ packs, scope, agents: agentArg, cwd });
  } catch (err) {
    return failExec(err, scope, parsed.json);
  }

  if (!parsed.json) renderList(entries, notSupportedRows, scope);
  if (parsed.json) {
    const actions: JsonAction[] = entries.map((e) => ({
      agents: [e.agent],
      packs: [e.pack],
      path: e.path,
      status: e.state,
      ...(e.reason ? { reason: e.reason } : {}),
    }));
    for (const a of notSupportedRows) {
      actions.push({ agents: [a], packs: [], path: '', status: 'not supported' });
    }
    emitJson({
      status: 'ok',
      scope,
      actions,
      summary: `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} at ${scope} scope`,
    });
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Human renderers
// ---------------------------------------------------------------------------

function planHasRefusal(plan: SkillsPlan): boolean {
  return plan.actions.some((a) => a.status === 'refuse');
}

function renderPlan(plan: SkillsPlan, opts: { dryRun: boolean }): void {
  if (opts.dryRun) writeOut('Dry run — no files will be changed.');
  renderActionsGroupedByAgent(plan.actions);
  for (const note of plan.notes) writeOut(`note: ${note}`);
  const counts = countStatuses(plan.actions);
  writeOut(summaryLine(counts));
}

function renderApply(plan: SkillsPlan, result: ApplyResult): void {
  renderActionsGroupedByAgent(plan.actions);
  for (const note of plan.notes) writeOut(`note: ${note}`);
  for (const notice of result.notices) writeOut(`note: ${notice}`);
  writeOut(
    `Summary: ${result.written.length} written, ${result.refused.length} refused.`,
  );
  for (const r of result.refused) {
    writeErr(`  refused ${r.relPath ?? r.path}: ${r.reason ?? 'unknown'}`);
    writeErr('    remedy: re-run with --force to override, or resolve the conflict manually.');
  }
}

function renderRemove(result: ApplyResult): void {
  for (const p of result.removed) writeOut(`removed  ${p}`);
  for (const notice of result.notices) writeOut(`note: ${notice}`);
  for (const r of result.refused) {
    writeErr(`refused  ${r.relPath ?? r.path}: ${r.reason ?? 'unknown'}`);
    writeErr('    remedy: re-run with --force to override, or resolve the conflict manually.');
  }
  writeOut(
    `Summary: ${result.removed.length} removed, ${result.refused.length} refused.`,
  );
}

function renderList(entries: ListEntry[], notSupported: string[], scope: Scope): void {
  const byAgent = new Map<string, ListEntry[]>();
  for (const e of entries) {
    const arr = byAgent.get(e.agent) ?? [];
    arr.push(e);
    byAgent.set(e.agent, arr);
  }
  for (const [agent, rows] of byAgent) {
    writeOut(`${agent} (${scope}):`);
    for (const r of rows) {
      writeOut(`  ${r.state.padEnd(20)}${r.path}  (${r.pack})`);
    }
  }
  for (const a of notSupported) {
    writeOut(`${a} (${scope}):`);
    writeOut('  not supported         (this agent has no skills target)');
  }
}

function renderActionsGroupedByAgent(actions: PlanAction[]): void {
  const byAgent = new Map<string, PlanAction[]>();
  for (const a of actions) {
    for (const agent of a.agents) {
      const arr = byAgent.get(agent) ?? [];
      arr.push(a);
      byAgent.set(agent, arr);
    }
  }
  for (const [agent, rows] of byAgent) {
    writeOut(`${agent}:`);
    for (const a of rows) {
      const label = a.relPath ?? a.path;
      const packs = a.packs.length ? a.packs.join(', ') : '—';
      writeOut(`  ${a.status.padEnd(10)}${label}  (${packs})`);
      if (a.status === 'refuse' && a.reason) {
        writeErr(`    reason: ${a.reason}`);
        writeErr('    remedy: re-run with --force to override, or resolve the conflict manually.');
      }
    }
  }
}

function countStatuses(actions: PlanAction[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const a of actions) counts[a.status] = (counts[a.status] ?? 0) + 1;
  return counts;
}

function summaryLine(counts: Record<string, number>): string {
  const parts = Object.entries(counts).map(([k, v]) => `${v} ${k}`);
  return `Summary: ${parts.length ? parts.join(', ') : 'nothing to do'}.`;
}

// ---------------------------------------------------------------------------
// JSON emitters
// ---------------------------------------------------------------------------

function emitPlanJson(plan: SkillsPlan, scope: Scope): void {
  emitJson({
    status: planHasRefusal(plan) ? 'error' : 'ok',
    scope,
    actions: plan.actions.map(actionToJson),
    summary: summaryLine(countStatuses(plan.actions)),
  });
}

function emitApplyJson(plan: SkillsPlan, result: ApplyResult, scope: Scope): void {
  emitJson({
    status: result.refused.length ? 'error' : 'ok',
    scope,
    actions: plan.actions.map(actionToJson),
    summary: `${result.written.length} written, ${result.refused.length} refused`,
  });
}

function emitRemoveJson(result: ApplyResult, scope: Scope): void {
  const actions: JsonAction[] = [];
  for (const p of result.removed) {
    actions.push({ agents: [], packs: [], path: p, status: 'remove' });
  }
  for (const r of result.refused) {
    actions.push(actionToJson(r));
  }
  emitJson({
    status: result.refused.length ? 'error' : 'ok',
    scope,
    actions,
    summary: `${result.removed.length} removed, ${result.refused.length} refused`,
  });
}

function failExec(err: unknown, scope: Scope, json: boolean): number {
  const msg = err instanceof Error ? err.message : String(err);
  writeErr(`skills failed: ${msg}`);
  if (json) emitJson({ status: 'error', scope, actions: [], summary: `execution failed: ${msg}` });
  return 1;
}

/** Cheap pre-parse peek so a flag error can still honor --json. */
function argvWantsJson(args: string[]): boolean {
  return args.includes('--json');
}
