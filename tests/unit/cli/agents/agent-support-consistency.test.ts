import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KNOWN_AGENT_IDS } from '../../../../src/cli/tui/flags-types.js';
import { AGENTS } from '../../../../src/cli/tui/agents.js';
import { JSON_SPECS } from '../../../../src/cli/tui/config-writer.js';
import { agentHandlers } from '../../../../src/cli/agents/registry.js';
import { SUPPORTED_AGENTS } from '../../../../src/cli/agents/skills/targets.js';

// Agents that are intentionally NOT wired into the TUI flag parser / detection
// descriptors / config-writer seams. cline is skills-only (the P4 engine writes
// its skill dirs); it deliberately has no `--agents=cline` flag and no
// JSON_SPECS MCP-config path, so it must be exempted from the drift guards
// below or they would fail claiming cline is "marketed but does nothing".
const TUI_ABSENT_BY_DESIGN = new Set(['cline']);

// Regression guard for the "marketed / flag-accepted agent that never actually
// wires up" class of bug (antigravity: in the registry but missing from the flag
// parser + detection + config-writer, so `--agents=antigravity` was rejected).
//
// The live MCP-config path is config-writer.ts (`applyConfigs` over `JSON_SPECS`
// + detection descriptors) — NOT the registry handlers' `installMcp`, which is
// dead code. So for an agent to REALLY work, three lists must agree:
//   1. KNOWN_AGENT_IDS  — what `--agents=<id>` accepts (flags-types.ts)
//   2. AGENTS ids       — what detectAgents() returns (agents.ts)
//   3. a config-writer path — JSON_SPECS entry, or the CLI (claude-code),
//      TOML (codex), or special shared helper paths.
// Drift between them = an agent that is offered but silently does nothing.

const CONFIG_WRITER_SPECIAL = new Set(['claude-code', 'codex', 'opencode']); // handled by CLI / TOML / helper path, not JSON_SPECS

describe('agent support seams stay consistent', () => {
  it('every flag-accepted id (KNOWN_AGENT_IDS) is also a detection descriptor, and vice versa', () => {
    const known = [...KNOWN_AGENT_IDS].sort();
    const detected = AGENTS.map((a) => a.id).sort();
    // If these diverge, either `--agents=<id>` accepts an id that can't be
    // detected/wired, or a detectable agent can't be requested by flag.
    expect(detected).toEqual(known);
  });

  it('every detectable agent has a real config-writer path (JSON_SPECS, CLI, or TOML)', () => {
    const missing = AGENTS.map((a) => a.id).filter(
      (id) => !CONFIG_WRITER_SPECIAL.has(id) && !(id in JSON_SPECS),
    );
    // A non-empty list here means an agent is marketed/flag-accepted but has no
    // way to actually write its MCP config — exactly the antigravity bug.
    expect(missing).toEqual([]);
  });

  it('includes antigravity end-to-end (the fixed agent)', () => {
    expect(KNOWN_AGENT_IDS).toContain('antigravity');
    expect(AGENTS.map((a) => a.id)).toContain('antigravity');
    expect('antigravity' in JSON_SPECS).toBe(true);
  });

  it('every detectable agent has uninstall ownership', () => {
    const handlerIds = new Set(agentHandlers.map((handler) => handler.id));
    const missing = AGENTS.map((agent) => agent.id).filter((id) => !handlerIds.has(id));
    expect(missing).toEqual([]);
  });

  it('cline is deliberately absent from TUI flags/detection/config-writer (skills-only)', () => {
    // Explicit exception record: cline is a skills-engine-only agent. If a future
    // slice adds cline MCP support, remove it from TUI_ABSENT_BY_DESIGN and wire
    // the three seams above.
    expect(TUI_ABSENT_BY_DESIGN.has('cline')).toBe(true);
    expect(KNOWN_AGENT_IDS).not.toContain('cline');
    expect(AGENTS.map((a) => a.id)).not.toContain('cline');
    expect('cline' in JSON_SPECS).toBe(false);
  });

  it('every skills-engine target agent is a real registry handler id', () => {
    // The targets table drives filesystem writes; each id must map to a
    // registered handler so detection/uninstall stay coherent.
    const registryIds = new Set(agentHandlers.map((h) => h.id));
    const orphans = SUPPORTED_AGENTS.filter((a) => !registryIds.has(a));
    expect(orphans).toEqual([]);
  });

  it('markets OpenCode consistently across the public support lists', () => {
    const surfaces = [
      'README.md',
      'docs/installation.md',
      'site/src/components/Quickstart.tsx',
      'site/src/components/TrustedBy.tsx',
      'site/public/llms.txt',
      'examples/quickstart-claude-code/README.md',
    ];
    const missing = surfaces.filter((path) => (
      !/opencode/i.test(readFileSync(join(process.cwd(), path), 'utf-8'))
    ));
    expect(missing).toEqual([]);
  });
});
