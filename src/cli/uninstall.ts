import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { detectInstalledHandlers } from './agents/registry.js';
import { getConfig } from '../config.js';

/**
 * The curl|sh bootstrap installer lays the tool down INSIDE the data dir:
 *   <dataDir>/bin      shim
 *   <dataDir>/tool     the installed CLI package
 *   <dataDir>/runtime  the pinned language runtime
 * The rest of <dataDir> (cache, models, keys) is user data. Detect that layout
 * so cleanup guidance never conflates "remove the tool" with "wipe all data".
 */
function detectBootstrapLayout(dataDir: string): { present: boolean; toolDir: string; runtimeDir: string; binDir: string } {
  const toolDir = join(dataDir, 'tool');
  const runtimeDir = join(dataDir, 'runtime');
  const binDir = join(dataDir, 'bin');
  const present = existsSync(toolDir) || existsSync(runtimeDir);
  return { present, toolDir, runtimeDir, binDir };
}

function cleanupGuidance(dataDir: string): string[] {
  const layout = detectBootstrapLayout(dataDir);
  if (!layout.present) {
    return [
      `Does NOT remove ${dataDir} data (cache, search engine, embeddings).`,
      `For a full cleanup run: rm -rf ${dataDir}`,
    ];
  }
  return [
    `This wigolo was installed via the curl|sh bootstrap. Its files live under`,
    `${dataDir} alongside your data:`,
    `  ${layout.binDir}      (shim)`,
    `  ${layout.toolDir}     (the CLI)`,
    `  ${layout.runtimeDir}  (the bundled runtime)`,
    '',
    'To remove the tool but KEEP your cache, models, and keys:',
    `  install.sh --uninstall   (or: rm -rf ${layout.binDir} ${layout.toolDir} ${layout.runtimeDir})`,
    '',
    'To wipe EVERYTHING including cache, models, and keys (this also deletes the tool):',
    `  rm -rf ${dataDir}`,
  ];
}

export async function runUninstall(args: string[]): Promise<number> {
  const help = args.includes('--help') || args.includes('-h');
  const useJson = args.includes('--json');
  const assumeYes = args.includes('--yes') || args.includes('-y');
  const dataDir = getConfig().dataDir;

  // --help wins over every other flag: `--json --help` is a help request, not a
  // destructive uninstall. Check it BEFORE the --json branches so no side effect
  // (including the skills sweep) can run when the user only asked for help.
  if (help) {
    process.stderr.write([
      'Usage: wigolo uninstall',
      '',
      'Removes all wigolo agent integrations:',
      '  - MCP server config',
      '  - Global instructions block',
      '  - Skills (~/.claude/skills/wigolo*/)',
      '  - Slash command (~/.claude/commands/wigolo.md)',
      '',
      `Does NOT remove ${dataDir} data (cache, search engine, embeddings).`,
      '',
      'Cleanup depends on how wigolo was installed:',
      `  - npm / source install: full cleanup is  rm -rf ${dataDir}`,
      '  - curl|sh bootstrap:     remove the tool with  install.sh --uninstall',
      `    (keeps your cache/models/keys), or  rm -rf ${dataDir}  to wipe everything.`,
      '',
    ].join('\n'));
    return 0;
  }

  // --json is machine-consumed and destructive; require explicit consent so a
  // script cannot wipe integrations without opting in. Gate before any side
  // effect (including the skills sweep) runs.
  if (useJson && !assumeYes) {
    process.stdout.write(`${JSON.stringify({
      error: 'refusing to uninstall non-interactively without --yes. Re-run with: wigolo uninstall --json --yes',
    })}\n`);
    return 1;
  }

  if (useJson) {
    return runUninstallJson(dataDir);
  }

  // Skills sweep — runs INDEPENDENT of detected handlers and BEFORE the
  // no-handlers early return, so receipt-driven skill packs are cleaned up even
  // when no agent binary is currently detected on this machine.
  let skillsRemoved = 0;
  let skillsLeft = 0;
  try {
    const { removeAllSkills } = await import('./agents/skills/index.js');
    const skills = removeAllSkills({ cwd: process.cwd() });
    skillsRemoved = skills.removed.length;
    skillsLeft = skills.refused.length;
    if (skillsRemoved > 0 || skillsLeft > 0) {
      process.stdout.write(`\nSkills: ${skillsRemoved} removed`);
      process.stdout.write(skillsLeft > 0 ? `, ${skillsLeft} left in place (modified or protected).\n` : '.\n');
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`  ! Skills sweep failed: ${message}\n`);
  }

  const handlers = detectInstalledHandlers();

  if (handlers.length === 0) {
    process.stdout.write('No agent integrations detected. Nothing to remove.\n');
    process.stdout.write('\n');
    process.stdout.write(cleanupGuidance(dataDir).join('\n') + '\n');
    return 0;
  }

  let totalRemoved = 0;

  for (const handler of handlers) {
    process.stdout.write(`\nRemoving ${handler.displayName}...\n`);
    try {
      const { removed } = await handler.uninstall();
      if (removed.length === 0) {
        process.stdout.write('  (nothing to remove)\n');
      } else {
        for (const item of removed) {
          process.stdout.write(`  ✓ Removed ${item}\n`);
          totalRemoved++;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`  ! Failed: ${message}\n`);
    }
  }

  process.stdout.write(`\nDone. ${totalRemoved} item(s) removed.\n`);
  process.stdout.write(`Note: ${dataDir} data (cache, search engine) preserved.\n`);
  process.stdout.write(cleanupGuidance(dataDir).join('\n') + '\n');

  return 0;
}

/**
 * --json variant: same sequence as the human path (skills sweep FIRST, then
 * handler removal — the sweep runs regardless of whether any handlers are
 * detected) but every progress line goes to stderr and a single plan+result
 * JSON document is written to stdout at the end.
 */
async function runUninstallJson(dataDir: string): Promise<number> {
  // Skills sweep — same position as the human path: BEFORE any handler check,
  // so receipt-driven skill packs are cleaned up even when no agent binary is
  // detected. Only the write channel differs (stderr, not stdout).
  let skillsRemoved = 0;
  let skillsLeft = 0;
  try {
    const { removeAllSkills } = await import('./agents/skills/index.js');
    const skills = removeAllSkills({ cwd: process.cwd() });
    skillsRemoved = skills.removed.length;
    skillsLeft = skills.refused.length;
    if (skillsRemoved > 0 || skillsLeft > 0) {
      process.stderr.write(`Skills: ${skillsRemoved} removed${skillsLeft > 0 ? `, ${skillsLeft} left in place.` : '.'}\n`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`  ! Skills sweep failed: ${message}\n`);
  }

  const handlers = detectInstalledHandlers();
  const handlerResults: Array<{ handler: string; removed: string[]; error?: string }> = [];
  let totalRemoved = 0;

  for (const handler of handlers) {
    process.stderr.write(`Removing ${handler.displayName}...\n`);
    try {
      const { removed } = await handler.uninstall();
      totalRemoved += removed.length;
      handlerResults.push({ handler: handler.displayName, removed });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`  ! Failed: ${message}\n`);
      handlerResults.push({ handler: handler.displayName, removed: [], error: message });
    }
  }

  process.stdout.write(`${JSON.stringify({
    status: 'ok',
    dataDir,
    dataPreserved: true,
    skills: { removed: skillsRemoved, left: skillsLeft },
    handlers: handlerResults,
    removed: totalRemoved,
  })}\n`);

  return 0;
}
