import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The base guard is the only thing standing between a program-branch PR and
// `main`. PR #309 was opened against `main` with 100 commits, went green, and
// reported MERGEABLE; nothing in CI looked at the base ref. These tests exist so
// that the guard cannot be quietly narrowed back to that state.
//
// Scope, stated honestly: this file verifies the workflow TEXT and the shell
// script the workflow runs. It cannot verify GitHub's own evaluation of the
// `contains()` expression or its event routing — no test in this repo can. What
// it does cover is the two ways the guard realistically regresses: someone
// trims `types:` (which silently reintroduces the retarget bypass), or someone
// rewrites the label check into a substring test.

const WORKFLOW_PATH = join(import.meta.dirname, '..', '..', '.github', 'workflows', 'base-guard.yml');
const RAW = readFileSync(WORKFLOW_PATH, 'utf-8');

const JOB_NAME = 'base guard (main)';

/** Parse a YAML inline flow sequence (`key: [a, b, c]`) off the raw workflow. */
function flowSeq(key: string): string[] {
  const m = RAW.match(new RegExp(`^\\s*${key}:\\s*\\[([^\\]]*)\\]`, 'm'));
  if (!m) throw new Error(`no inline sequence found for "${key}" in base-guard.yml`);
  return m[1]
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

/**
 * Read the `run:` block scalar out of the workflow. Hand-rolled because no YAML
 * parser is a declared dependency of this repo — adding one to satisfy a test
 * would be a worse trade than 15 lines of indentation handling.
 */
function runScript(): string {
  const lines = RAW.split('\n');
  const start = lines.findIndex((l) => /^\s*run:\s*\|\s*$/.test(l));
  if (start === -1) throw new Error('no "run: |" block found in base-guard.yml');
  const indent = lines[start].match(/^(\s*)/)![1].length;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && line.match(/^(\s*)/)![1].length <= indent) break;
    body.push(line.slice(indent + 2));
  }
  return body.join('\n');
}

/**
 * GitHub's `contains(seq, item)`: membership over ARRAY ELEMENTS,
 * case-insensitive, values cast to string. Deliberately NOT a substring test —
 * that difference is the whole point of the near-miss cases below.
 */
const containsSeq = (seq: string[], item: string): boolean =>
  seq.some((v) => String(v).toLowerCase() === String(item).toLowerCase());

/** The label the workflow actually requires, read from the workflow itself. */
function requiredLabel(): string {
  const m = RAW.match(/contains\(\s*github\.event\.pull_request\.labels\.\*\.name\s*,\s*'([^']+)'\s*\)/);
  if (!m) throw new Error('base-guard.yml no longer checks labels with the array form of contains()');
  return m[1];
}

interface GuardResult {
  code: number;
  output: string;
  summary: string;
}

/** Execute the workflow's real script the way the runner would. */
function runGuard(labels: string[], overrides: Record<string, string> = {}): GuardResult {
  const dir = mkdtempSync(join(tmpdir(), 'base-guard-'));
  // Forward slashes: bash on Windows runners chokes on backslash paths.
  const norm = (p: string) => p.replace(/\\/g, '/');
  const scriptPath = join(dir, 'guard.sh');
  const summaryPath = join(dir, 'summary.md');
  writeFileSync(scriptPath, runScript());
  writeFileSync(summaryPath, '');

  const env = {
    PATH: process.env.PATH,
    HAS_LABEL: String(containsSeq(labels, requiredLabel())),
    PR_NUMBER: '309',
    HEAD_REF: 'slice-f2-rerank-noop-notice',
    BASE_REF: 'main',
    COMMIT_COUNT: '100',
    GITHUB_STEP_SUMMARY: norm(summaryPath),
    ...overrides,
  };

  try {
    const output = execFileSync('bash', [norm(scriptPath)], { env, encoding: 'utf-8' });
    return { code: 0, output, summary: readFileSync(summaryPath, 'utf-8') };
  } catch (e) {
    const err = e as { status: number; stdout?: string; stderr?: string };
    return {
      code: err.status,
      output: `${err.stdout ?? ''}${err.stderr ?? ''}`,
      summary: readFileSync(summaryPath, 'utf-8'),
    };
  }
}

describe('base-guard workflow — trigger configuration', () => {
  it('runs on pull_request and never on pull_request_target', () => {
    // pull_request_target would run with a privileged context on fork PRs. This
    // job checks out nothing and needs no secrets, so that would be pure risk.
    // Matched as a trigger KEY, not as a string: the file names
    // `pull_request_target` in a comment explaining why it is not used.
    expect(RAW).toMatch(/^\s*pull_request:\s*$/m);
    expect(RAW).not.toMatch(/^\s*pull_request_target:\s*$/m);
  });

  it('only fires for pull requests targeting main', () => {
    // The branch filter is evaluated against the branch the PR TARGETS, so this
    // is what keeps the guard off every program-branch PR in the repo.
    expect(flowSeq('branches')).toEqual(['main']);
  });

  it('re-runs when a pull request is retargeted onto main', () => {
    // Changing a PR's base emits `edited`, NOT `synchronize`. Without `edited`
    // in this list a PR could be opened against the program branch and then
    // retargeted at main with `gh pr edit --base main`, and the guard would
    // never run at all — the exact bypass the guard exists to prevent.
    expect(flowSeq('types')).toContain('edited');
  });

  it('re-runs when labels change so the check can go green without a push', () => {
    // A guard that stays red after you satisfy it is a guard people route
    // around. Both label events are needed: `unlabeled` re-arms it if the
    // authorising label is removed again.
    expect(flowSeq('types')).toEqual(expect.arrayContaining(['labeled', 'unlabeled']));
  });

  it('covers the ordinary pull request lifecycle events', () => {
    expect(flowSeq('types')).toEqual(expect.arrayContaining(['opened', 'reopened', 'synchronize']));
  });

  it('keeps the job name stable so it can be made a required check', () => {
    // Renaming this silently detaches it from `main`'s required_status_checks.
    expect(RAW).toContain(`name: ${JOB_NAME}`);
  });

  it('requests no write permissions', () => {
    expect(RAW).toMatch(/permissions:\s*\n\s*contents:\s*read/);
    expect(RAW).not.toMatch(/contents:\s*write/);
  });
});

describe('base-guard workflow — label expression', () => {
  it('reads the label from the event payload rather than shelling out to gh', () => {
    // The payload already carries the current label set on every trigger type
    // above, including the label events themselves. Calling `gh` would add a
    // token requirement and a rate limit to learn what we were already handed.
    expect(RAW).toContain('github.event.pull_request.labels.*.name');
    expect(RAW).toMatch(/HAS_LABEL:\s*\$\{\{/);
    // Targets the DECISION, not the prose: the failure message legitimately
    // prints `gh pr edit` as a remedy, so this asserts that no gh invocation
    // ever feeds the label lookup.
    expect(RAW).not.toMatch(/--json\s+labels/);
  });

  it('matches whole label names, not substrings of them', () => {
    // `labels.*.name` yields an ARRAY, and contains(array, item) compares
    // elements. Against a plain string contains() is a substring test, and a
    // stray `no-release-to-main` label would silently authorise a release.
    const expr = RAW.match(/HAS_LABEL:\s*\$\{\{(.+?)\}\}/s);
    expect(expr, 'HAS_LABEL expression missing from base-guard.yml').not.toBeNull();
    expect(expr![1]).toContain('labels.*.name');
    // A join()/toJSON() would collapse the array to a string and reintroduce
    // substring matching.
    expect(expr![1]).not.toMatch(/join\(|toJSON\(/);
  });
});

describe('base-guard workflow — near-miss labels must not satisfy the guard', () => {
  // Built from the label the workflow actually requires, so renaming the label
  // moves these cases with it instead of leaving them asserting a stale string.
  const label = requiredLabel();

  it.each([`no-${label}`, `${label}-later`, 'ci'])('does not accept %s', (nearMiss) => {
    expect(containsSeq([nearMiss], label)).toBe(false);
  });
});

describe('base-guard workflow — executed guard script', () => {
  it('extracts the real script from the workflow', () => {
    // Control. If the block-scalar reader silently returned an empty string,
    // bash would exit 0 and every "passes" assertion below would still be
    // green while the "fails" ones broke — so pin the extraction itself.
    const script = runScript();
    expect(script).toContain('set -euo pipefail');
    expect(script).toContain('exit 1');
    expect(script.split('\n').length).toBeGreaterThan(10);
  });

  it('fails a pull request targeting main with no labels', () => {
    const { code } = runGuard([]);
    expect(code).toBe(1);
  });

  it('tells the reader both ways out when it fails', () => {
    // A guard whose failure does not explain itself gets bypassed rather than
    // understood. Both remedies have to be in the output.
    const { output, summary } = runGuard([]);
    expect(output).toContain(requiredLabel());
    expect(output).toMatch(/--base/); // retarget the PR
    expect(output).toMatch(/--add-label/); // or authorise it
    expect(output).toContain('::error title='); // annotated in the checks UI
    expect(output).toContain('100'); // the commit count that gave #309 away
    expect(summary).toContain('Base guard failed');
  });

  it('passes a pull request carrying the authorising label', () => {
    const { code, output } = runGuard([requiredLabel()]);
    expect(code).toBe(0);
    expect(output).not.toContain('::error');
  });

  it('passes when the authorising label sits among unrelated labels', () => {
    expect(runGuard(['bug', requiredLabel(), 'p1']).code).toBe(0);
  });
});
