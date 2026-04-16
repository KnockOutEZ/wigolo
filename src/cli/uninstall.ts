import { detectInstalledHandlers } from './agents/registry.js';

export async function runUninstall(args: string[]): Promise<number> {
  const help = args.includes('--help') || args.includes('-h');
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
      'Does NOT remove ~/.wigolo data (cache, search engine, embeddings).',
      'For a full cleanup run: rm -rf ~/.wigolo',
      '',
    ].join('\n'));
    return 0;
  }

  const handlers = detectInstalledHandlers();

  if (handlers.length === 0) {
    process.stdout.write('No agent integrations detected. Nothing to remove.\n');
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
  process.stdout.write('Note: ~/.wigolo data (cache, search engine) preserved.\n');
  process.stdout.write('For full cleanup: rm -rf ~/.wigolo\n');

  return 0;
}
