import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { getConfig } from '../config.js';

function log(msg: string): void {
  process.stderr.write(`[wigolo plugin] ${msg}\n`);
}

function extractRepoName(gitUrl: string): string {
  // Handle SSH-style URLs: git@github.com:user/repo.git
  if (gitUrl.includes(':') && !gitUrl.includes('://')) {
    const parts = gitUrl.split(':');
    const pathPart = parts[parts.length - 1];
    const name = basename(pathPart, '.git');
    if (!name) throw new Error('could not extract repo name from URL');
    return name;
  }

  // Handle HTTPS URLs
  try {
    const url = new URL(gitUrl);
    const pathParts = url.pathname.split('/').filter(Boolean);
    if (pathParts.length === 0) {
      throw new Error('could not extract repo name from URL');
    }
    const last = pathParts[pathParts.length - 1];
    return last.endsWith('.git') ? last.slice(0, -4) : last;
  } catch (err) {
    if (err instanceof TypeError) {
      throw new Error(`invalid git URL: ${gitUrl}`);
    }
    throw err;
  }
}

function validatePluginName(name: string): void {
  if (!name || name.trim().length === 0) {
    throw new Error('plugin name is required');
  }
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new Error(`invalid plugin name: ${name} (must not contain path separators or "..")`);
  }
  if (name.startsWith('/')) {
    throw new Error(`invalid plugin name: ${name} (must not be an absolute path)`);
  }
}

export function runPluginAdd(gitUrl: string): void {
  if (!gitUrl || gitUrl.trim().length === 0) {
    throw new Error('git url is required');
  }

  const config = getConfig();
  const pluginsDir = config.pluginsDir;
  const repoName = extractRepoName(gitUrl);

  const targetDir = join(pluginsDir, repoName);
  if (existsSync(targetDir)) {
    throw new Error(
      `plugin "${repoName}" already exists at ${targetDir}. ` +
      `Remove it first: wigolo plugin remove ${repoName}`,
    );
  }

  mkdirSync(pluginsDir, { recursive: true });

  log(`cloning ${gitUrl} into ${targetDir}...`);
  try {
    execFileSync('git', ['clone', '--depth', '1', gitUrl, repoName], {
      cwd: pluginsDir,
      stdio: 'pipe',
      timeout: 60000,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`clone failed: ${message}`);
  }

  log(`plugin "${repoName}" installed successfully`);

  // Check for package.json with main field
  const pkgPath = join(targetDir, 'package.json');
  if (!existsSync(pkgPath)) {
    log('WARNING: plugin has no package.json -- it may not load correctly');
  } else {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { main?: string };
      if (!pkg.main) {
        log('WARNING: package.json has no "main" field -- plugin may not load');
      }
    } catch {
      log('WARNING: package.json is not valid JSON');
    }
  }
}

export function runPluginList(): void {
  const config = getConfig();
  const pluginsDir = config.pluginsDir;

  if (!existsSync(pluginsDir)) {
    log('no plugins installed');
    return;
  }

  let entries: string[];
  try {
    entries = readdirSync(pluginsDir);
  } catch {
    log('no plugins installed (could not read plugins directory)');
    return;
  }

  const plugins: Array<{ name: string; version: string; dir: string }> = [];

  for (const entry of entries) {
    const dir = join(pluginsDir, entry);
    let stat;
    try {
      stat = statSync(dir);
    } catch {
      continue;
    }
    if (!stat.isDirectory() && !stat.isSymbolicLink()) continue;

    let name = entry;
    let version = 'unknown';

    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')) as {
        name?: string;
        version?: string;
      };
      name = pkg.name ?? entry;
      version = pkg.version ?? 'unknown';
    } catch {
      // package.json missing or malformed -- use directory name
    }

    plugins.push({ name, version, dir });
  }

  if (plugins.length === 0) {
    log('no plugins installed');
    return;
  }

  log(`installed plugins (${plugins.length}):\n`);
  for (const p of plugins) {
    process.stderr.write(`  ${p.name} (${p.version})\n`);
    process.stderr.write(`    ${p.dir}\n\n`);
  }
}

export function runPluginRemove(name: string): void {
  validatePluginName(name);

  const config = getConfig();
  const pluginsDir = config.pluginsDir;
  const targetDir = join(pluginsDir, name);

  if (!existsSync(targetDir)) {
    throw new Error(`plugin "${name}" not found at ${targetDir}`);
  }

  log(`removing plugin "${name}"...`);
  try {
    rmSync(targetDir, { recursive: true, force: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`remove "${name}" failed: ${message}`);
  }

  log(`plugin "${name}" removed successfully`);
}

export function runPluginCommand(args: string[]): void {
  const subcommand = args[0];

  switch (subcommand) {
    case 'add': {
      const gitUrl = args[1];
      if (!gitUrl) {
        process.stderr.write('Usage: wigolo plugin add <git-url>\n');
        return;
      }
      runPluginAdd(gitUrl);
      break;
    }
    case 'list':
      runPluginList();
      break;
    case 'remove': {
      const name = args[1];
      if (!name) {
        process.stderr.write('Usage: wigolo plugin remove <name>\n');
        return;
      }
      runPluginRemove(name);
      break;
    }
    default:
      process.stderr.write(
        'Usage: wigolo plugin <add|list|remove>\n\n' +
        '  add <git-url>    Clone a plugin repository\n' +
        '  list             List installed plugins\n' +
        '  remove <name>    Remove an installed plugin\n',
      );
      break;
  }
}
