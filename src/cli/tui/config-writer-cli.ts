import { runCommand } from './run-command.js';

export interface InstallViaClaudeCliArgs {
  dryRun?: boolean;
}

export interface InstallViaClaudeCliResult {
  ok: boolean;
  code?: 'OK' | 'CLAUDE_NOT_FOUND' | 'CLAUDE_FAILED';
  message?: string;
  alreadyInstalled?: boolean;
  dryRun?: boolean;
}

export async function installViaClaudeCli(args: InstallViaClaudeCliArgs = {}): Promise<InstallViaClaudeCliResult> {
  if (args.dryRun) {
    return { ok: true, code: 'OK', dryRun: true };
  }

  let r;
  try {
    r = await runCommand(
      'claude',
      ['mcp', 'add', 'wigolo', '--', 'npx', '-y', '@staticn0va/wigolo'],
      { timeout: 15000 },
    );
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT' || /ENOENT|spawn .* ENOENT/.test(e.message)) {
      return {
        ok: false,
        code: 'CLAUDE_NOT_FOUND',
        message: 'Claude Code CLI not found on PATH. Install it from https://claude.com/download',
      };
    }
    return { ok: false, code: 'CLAUDE_FAILED', message: e.message };
  }

  if (r.code === 0) {
    return { ok: true, code: 'OK', alreadyInstalled: false };
  }
  if (/already exists/i.test(r.stderr) || /already exists/i.test(r.stdout)) {
    return { ok: true, code: 'OK', alreadyInstalled: true };
  }
  return {
    ok: false,
    code: 'CLAUDE_FAILED',
    message: (r.stderr || r.stdout || `exit ${r.code}`).trim(),
  };
}
