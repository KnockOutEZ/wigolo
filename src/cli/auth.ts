import { getConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { listSessions } from '../fetch/auth.js';

const log = createLogger('cli');

function write(text: string): void {
  process.stderr.write(text + '\n');
}

async function discoverCommand(): Promise<number> {
  const config = getConfig();

  if (!config.cdpUrl) {
    write('Error: WIGOLO_CDP_URL is not configured.');
    write('Set it to your Chrome debugging endpoint, e.g.:');
    write('  export WIGOLO_CDP_URL=http://localhost:9222');
    write('');
    write('Launch Chrome with debugging enabled:');
    write('  google-chrome --remote-debugging-port=9222');
    return 1;
  }

  try {
    const sessions = await listSessions();

    if (sessions.length === 0) {
      write('No active CDP sessions found.');
      write(`Endpoint: ${config.cdpUrl}`);
      write('');
      write('Make sure Chrome is running with --remote-debugging-port=9222');
      return 0;
    }

    write(`Found ${sessions.length} active session(s) at ${config.cdpUrl}:\n`);

    for (const session of sessions) {
      write(`  ID:    ${session.id}`);
      write(`  Title: ${session.title || '(untitled)'}`);
      write(`  URL:   ${session.url}`);
      write(`  WS:    ${session.webSocketDebuggerUrl}`);
      if (session.type) {
        write(`  Type:  ${session.type}`);
      }
      write('');
    }

    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    write(`Error discovering CDP sessions: ${message}`);
    log.error('auth discover failed', { error: message });
    return 1;
  }
}

async function statusCommand(useJson: boolean): Promise<number> {
  const config = getConfig();

  if (useJson) {
    // Machine shape on stdout; presence booleans + the user-configured
    // path/endpoint values only. No credential material (browser storage
    // state, profile contents, or API tokens) is ever read or emitted here.
    process.stdout.write(`${JSON.stringify({
      status: 'ok',
      storageState: { configured: Boolean(config.authStatePath), path: config.authStatePath ?? null },
      chromeProfile: { configured: Boolean(config.chromeProfilePath), path: config.chromeProfilePath ?? null },
      cdp: { configured: Boolean(config.cdpUrl), url: config.cdpUrl ?? null },
      fallbackOrder: ['storageState', 'chromeProfile', 'cdp'],
    })}\n`);
    return 0;
  }

  write('Auth Configuration Status:\n');

  if (config.authStatePath) {
    write(`  Storage State: ${config.authStatePath}`);
  } else {
    write('  Storage State: not configured (WIGOLO_AUTH_STATE_PATH)');
  }

  if (config.chromeProfilePath) {
    write(`  Chrome Profile: ${config.chromeProfilePath}`);
  } else {
    write('  Chrome Profile: not configured (WIGOLO_CHROME_PROFILE_PATH)');
  }

  if (config.cdpUrl) {
    write(`  CDP URL: ${config.cdpUrl}`);
  } else {
    write('  CDP URL: not configured (WIGOLO_CDP_URL)');
  }

  write('');

  const hasAny = config.authStatePath || config.chromeProfilePath || config.cdpUrl;
  if (!hasAny) {
    write('  No auth methods configured. Set one of the above env vars.');
  } else {
    write('  Fallback order: Storage State > Chrome Profile > CDP');
  }

  return 0;
}

export async function runAuth(args: string[]): Promise<number> {
  const useJson = args.includes('--json');
  const subcommand = args.find((a) => !a.startsWith('-'));

  switch (subcommand) {
    case 'discover':
      return discoverCommand();

    case 'status':
      return statusCommand(useJson);

    default:
      write('Usage: wigolo auth <subcommand>');
      write('');
      write('Subcommands:');
      write('  discover    List active Chrome CDP debugging sessions');
      write('  status      Show current auth configuration');
      return 1;
  }
}
