import { detectAgents } from './tui/agents.js';
import type { AgentId } from './tui/agents.js';
import { selectAgents, NotTtyError } from './tui/select-agents.js';
import { applyConfigs, type ConfigApplyResult } from './tui/config-writer.js';
import { printAddMcpBanner } from './tui/banner.js';
import { parseSetupMcpFlags, FlagParseError } from './tui/flags.js';

const USAGE = [
  'Usage: wigolo setup <subcommand> [options]',
  '',
  'Subcommands:',
  '  mcp    Configure wigolo in your AI tools (Claude Code, Cursor, ...)',
  '',
  'Examples:',
  '  npx @staticn0va/wigolo setup mcp',
  '  npx @staticn0va/wigolo setup mcp --non-interactive --agents=claude-code,cursor',
].join('\n');

function writeErr(line: string): void {
  process.stderr.write(`${line}\n`);
}

export async function runSetupMcp(args: string[]): Promise<number> {
  const sub = args[0];
  if (!sub) {
    writeErr(USAGE);
    return 2;
  }
  if (sub !== 'mcp') {
    writeErr(`Unknown subcommand: ${sub}`);
    writeErr(USAGE);
    return 2;
  }

  let flags;
  try {
    flags = parseSetupMcpFlags(args);
  } catch (err) {
    if (err instanceof FlagParseError) {
      writeErr(err.message);
      writeErr(USAGE);
      return 2;
    }
    throw err;
  }

  if (flags.help) {
    writeErr(USAGE);
    return 0;
  }

  printAddMcpBanner();

  let detected;
  try {
    detected = await detectAgents({});
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeErr(`Agent detection failed: ${message}`);
    return 1;
  }

  if (detected.length === 0) {
    writeErr('No supported AI tools detected on this machine.');
    writeErr('Supported: Claude Code, Cursor, VS Code, Zed, Gemini CLI, Windsurf, Codex, OpenCode.');
    writeErr('Install one of them, then re-run: npx @staticn0va/wigolo setup mcp');
    return 0;
  }

  let selected: AgentId[] = [];
  if (flags.nonInteractive) {
    if (flags.agents.length === 0) {
      writeErr('--non-interactive requires --agents=<csv>');
      writeErr(USAGE);
      return 2;
    }
    selected = [...flags.agents] as AgentId[];
  } else {
    try {
      selected = await selectAgents(detected);
    } catch (err) {
      if (err instanceof NotTtyError) {
        writeErr('setup mcp requires an interactive terminal.');
        writeErr('Use --non-interactive --agents=<comma-list> in scripts or CI.');
        return 2;
      }
      const message = err instanceof Error ? err.message : String(err);
      writeErr(`Selection failed: ${message}`);
      return 1;
    }
  }

  if (selected.length === 0) {
    writeErr('No agents selected — nothing to do.');
    return 0;
  }

  let results: ConfigApplyResult[];
  try {
    results = await applyConfigs(detected, selected, {});
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeErr(`Writing configs failed: ${message}`);
    return 1;
  }

  writeErr('');
  writeErr('Summary:');
  let hadError = false;
  for (const r of results) {
    const name = r.displayName;
    if (r.ok) {
      writeErr(`  ✓ ${name}: ${r.configPath ?? r.code}`);
    } else {
      hadError = true;
      const loc = r.configPath ? ` (${r.configPath})` : '';
      writeErr(`  ✗ ${name}: ${r.message ?? r.code}${loc}`);
    }
  }
  writeErr('');

  return hadError ? 1 : 0;
}
