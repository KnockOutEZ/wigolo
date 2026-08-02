import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HELP_TEXT, TOOL_HELP, TOOL_COMMANDS } from '../../../src/cli/help.js';
import { toolFlagSpecs } from '../../../src/cli/flag-bridge.js';

/**
 * Discover every `case '<cmd>':` in the top-level command switch of
 * src/index.ts. The two completeness assertions below are keyed off this so a
 * future command that is routed but never documented fails the test.
 */
function indexCaseCommands(): string[] {
  const src = readFileSync(
    join(import.meta.dirname, '..', '..', '..', 'src', 'index.ts'),
    'utf-8',
  );
  const cmds = new Set<string>();
  for (const m of src.matchAll(/case '([a-z_-]+)':/g)) {
    cmds.add(m[1]);
  }
  return [...cmds];
}

// APPEARANCE allowlist: commands NOT required to literally appear in the global
// help body. `mcp`/`unknown` are internal routing; `help`/`version` are the
// meta pair; `find_similar` is the snake alias documented beside find-similar.
// `studio` is INTENTIONALLY unadvertised while the Studio UX is incomplete —
// documenting it now would present a half-built surface as finished; it joins the
// help the moment that ships.
// `serve` MUST appear, so it is deliberately NOT here.
const APPEARANCE_ALLOWLIST = new Set(['mcp', 'help', 'version', 'unknown', 'find_similar', 'studio']);

// FLAGS-BLOCK allowlist: adds `serve` — it appears in the global help but its
// one-line "no --json (protocol)" note is a sufficient block.
const FLAGS_BLOCK_ALLOWLIST = new Set([
  'mcp',
  'help',
  'version',
  'unknown',
  'find_similar',
  'serve',
  // Unadvertised while the Studio UX is incomplete — see the APPEARANCE note above.
  'studio',
]);

// Properties reachable some other way than a derived --flag (positional / verb /
// subcommand / inline dual-mode). They are not required in per-tool help tables.
const PROPERTY_EXCLUSIONS = new Set([
  'url',
  'prompt',
  'question',
  'query',
  'action',
  'clear',
  'stats',
  'old',
  'new',
]);

describe('global help — APPEARANCE completeness', () => {
  it('every routed command appears in the global help body', () => {
    for (const cmd of indexCaseCommands()) {
      if (APPEARANCE_ALLOWLIST.has(cmd)) continue;
      expect(HELP_TEXT, `command '${cmd}' missing from global help`).toContain(cmd);
    }
  });

  it('serve, tune and dashboard are all documented', () => {
    expect(HELP_TEXT).toContain('serve');
    expect(HELP_TEXT).toContain('tune');
    expect(HELP_TEXT).toContain('dashboard');
  });
});

describe('global help — FLAGS-BLOCK completeness', () => {
  it('every appearing command has a usage/flags block', () => {
    // A "block" = the command name appears with a description on its own line
    // (i.e. followed by non-newline text). We assert each appearing command has
    // at least one line where it is followed by descriptive text.
    for (const cmd of indexCaseCommands()) {
      if (FLAGS_BLOCK_ALLOWLIST.has(cmd)) continue;
      const hasBlock = HELP_TEXT.split('\n').some((line) => {
        const idx = line.indexOf(cmd);
        return idx >= 0 && line.slice(idx + cmd.length).trim().length > 0;
      });
      expect(hasBlock, `command '${cmd}' has no usage/flags line`).toBe(true);
    }
  });
});

describe('per-tool help — every schema property surfaces as a flag', () => {
  it('each non-excluded schema property appears in its tool --help', () => {
    for (const cmd of TOOL_COMMANDS) {
      const help = TOOL_HELP[cmd];
      for (const spec of toolFlagSpecs(cmd)) {
        if (PROPERTY_EXCLUSIONS.has(spec.key)) continue;
        expect(
          help,
          `--${spec.flag} (${cmd}) missing from its --help`,
        ).toContain(`--${spec.flag}`);
      }
    }
  });
});

describe('help text — capability language only', () => {
  it('never leaks implementation dependency names', () => {
    const full = HELP_TEXT + '\n' + TOOL_COMMANDS.map((c) => TOOL_HELP[c]).join('\n');
    expect(full).not.toMatch(/playwright|searxng|flaresolverr|onnx|readability|defuddle|turndown/i);
  });
});
