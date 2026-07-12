import { describe, it, expect } from 'vitest';
import { KNOWN_AGENT_IDS } from '../../../../src/cli/tui/flags-types.js';
import { AGENTS } from '../../../../src/cli/tui/agents.js';
import { JSON_SPECS } from '../../../../src/cli/tui/config-writer.js';

// Regression guard for the "marketed / flag-accepted agent that never actually
// wires up" class of bug (antigravity: in the registry but missing from the flag
// parser + detection + config-writer, so `--agents=antigravity` was rejected).
//
// The live MCP-config path is config-writer.ts (`applyConfigs` over `JSON_SPECS`
// + detection descriptors) — NOT the registry handlers' `installMcp`, which is
// dead code. So for an agent to REALLY work, three lists must agree:
//   1. KNOWN_AGENT_IDS  — what `--agents=<id>` accepts (flags-types.ts)
//   2. AGENTS ids       — what detectAgents() returns (agents.ts)
//   3. a config-writer path — JSON_SPECS entry, or the CLI (claude-code) / TOML (codex) branch
// Drift between them = an agent that is offered but silently does nothing.

const CONFIG_WRITER_SPECIAL = new Set(['claude-code', 'codex']); // handled by CLI / TOML branches, not JSON_SPECS

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
});
