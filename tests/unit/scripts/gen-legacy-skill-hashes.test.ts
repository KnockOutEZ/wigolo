import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..', 'scripts', 'gen-legacy-skill-hashes.mjs',
);

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

describe('gen-legacy-skill-hashes', () => {
  let repo: string;

  const git = (...args: string[]): void => {
    execFileSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
      { cwd: repo, stdio: 'ignore' },
    );
  };
  const writeSkill = (text: string): void => {
    mkdirSync(join(repo, 'skills', 'wigolo-cache'), { recursive: true });
    writeFileSync(join(repo, 'skills', 'wigolo-cache', 'SKILL.md'), text);
  };
  const manifestPath = (): string => join(repo, 'assets', 'legacy-skill-hashes.json');
  const generate = (): Record<string, string[]> => {
    execFileSync(process.execPath, [SCRIPT], { cwd: repo, stdio: 'ignore' });
    return JSON.parse(readFileSync(manifestPath(), 'utf-8')) as Record<string, string[]>;
  };

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'wigolo-legacy-hashes-'));
    git('init', '-q');
    mkdirSync(join(repo, 'assets'), { recursive: true });
    // Packs with no files: an empty pack directory must not break the walk.
    mkdirSync(join(repo, 'skills', 'wigolo-diff'), { recursive: true });
    mkdirSync(join(repo, 'skills', 'wigolo-watch'), { recursive: true });
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('keeps hashes the manifest already records', () => {
    const recorded = 'f'.repeat(64);
    writeFileSync(manifestPath(), JSON.stringify({ _comment: 'x', 'wigolo-cache/SKILL.md': [recorded] }));
    writeSkill('v1\n');
    git('add', '.');
    git('commit', '-q', '-m', 'v1');

    expect(generate()['wigolo-cache/SKILL.md']).toContain(recorded);
  });

  it('records every version committed under skills/ plus the working tree', () => {
    writeSkill('v1\n');
    git('add', '.');
    git('commit', '-q', '-m', 'v1');
    writeSkill('v2\r\n');
    git('add', '.');
    git('commit', '-q', '-m', 'v2');
    writeSkill('v3\n');

    const manifest = generate();
    expect(manifest['wigolo-cache/SKILL.md']).toEqual([sha('v1\n'), sha('v2\n'), sha('v3\n')].sort());
    expect(manifest._comment).toContain('gen-legacy-skill-hashes');
  });

  it('is stable when run twice', () => {
    writeSkill('v1\n');
    git('add', '.');
    git('commit', '-q', '-m', 'v1');
    const first = generate();
    expect(generate()).toEqual(first);
  });
});
