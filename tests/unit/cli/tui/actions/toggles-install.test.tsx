/**
 * Tests the REAL toggle teeth: drives the actual useInstall hook (via
 * InstallProgress) with a mocked runWarmup, and asserts which flags useInstall
 * actually passes for each toggle state. This is production code under test —
 * it fails if useInstall's flag-building changes.
 *
 * Also covers buildInstallFlags directly (the exported single source of truth).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';

const runWarmupMock = vi.hoisted(() => vi.fn().mockResolvedValue({}));

vi.mock('../../../../../src/cli/warmup.js', () => ({
  runWarmup: runWarmupMock,
}));

import { InstallProgress } from '../../../../../src/cli/tui/components/InstallProgress.js';
import { buildInstallFlags } from '../../../../../src/cli/tui/hooks/useInstall.js';
import { buildDefaultToggles } from '../../../../../src/cli/tui/actions/types.js';

beforeEach(() => {
  runWarmupMock.mockClear();
});

afterEach(() => {
  cleanup();
});

/** Wait a tick for the useEffect's dynamic import + runWarmup to fire. */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 30));
}

describe('useInstall — real runWarmup flags (chromium required, searxng optional)', () => {
  it('default toggles: runWarmup runs (chromium) with --reranker --embeddings, no --no-searxng', async () => {
    const toggles = buildDefaultToggles(false);
    render(<InstallProgress browser="chromium" onComplete={() => {}} toggles={toggles} />);
    await flush();

    expect(runWarmupMock).toHaveBeenCalledTimes(1);
    const flags = runWarmupMock.mock.calls[0][0] as string[];
    expect(flags).toContain('--reranker');
    expect(flags).toContain('--embeddings');
    expect(flags).not.toContain('--no-searxng');
  });

  it('searxng OFF: runWarmup is called WITH --no-searxng (real skip, not cosmetic)', async () => {
    const toggles = { ...buildDefaultToggles(false), searxng: false };
    render(<InstallProgress browser="chromium" onComplete={() => {}} toggles={toggles} />);
    await flush();

    expect(runWarmupMock).toHaveBeenCalledTimes(1);
    const flags = runWarmupMock.mock.calls[0][0] as string[];
    expect(flags).toContain('--no-searxng');
  });

  it('reranker OFF: --reranker is absent', async () => {
    const toggles = { ...buildDefaultToggles(false), reranker: false };
    render(<InstallProgress browser="chromium" onComplete={() => {}} toggles={toggles} />);
    await flush();

    const flags = runWarmupMock.mock.calls[0][0] as string[];
    expect(flags).not.toContain('--reranker');
    expect(flags).toContain('--embeddings');
  });

  it('embeddings OFF: --embeddings is absent', async () => {
    const toggles = { ...buildDefaultToggles(false), embeddings: false };
    render(<InstallProgress browser="chromium" onComplete={() => {}} toggles={toggles} />);
    await flush();

    const flags = runWarmupMock.mock.calls[0][0] as string[];
    expect(flags).not.toContain('--embeddings');
  });

  it('chromium is required: runWarmup ALWAYS runs even with all optional toggles off', async () => {
    const toggles = {
      ...buildDefaultToggles(false),
      searxng: false,
      reranker: false,
      embeddings: false,
      chromium: false, // attempt to disable — must be ignored
    };
    render(<InstallProgress browser="chromium" onComplete={() => {}} toggles={toggles} />);
    await flush();

    // runWarmup STILL runs because it installs chromium (the required engine).
    expect(runWarmupMock).toHaveBeenCalledTimes(1);
    const flags = runWarmupMock.mock.calls[0][0] as string[];
    // searxng skipped, no reranker/embeddings, but chromium install proceeds.
    expect(flags).toContain('--no-searxng');
    expect(flags).not.toContain('--reranker');
    expect(flags).not.toContain('--embeddings');
  });
});

describe('buildInstallFlags — exported single source of truth', () => {
  it('chromium toggle off is ignored (required) — no flag suppresses chromium', () => {
    const toggles = { ...buildDefaultToggles(false), chromium: false };
    const flags = buildInstallFlags('chromium', toggles);
    // There is no "--no-chromium" — chromium always installs.
    expect(flags).not.toContain('--no-chromium');
  });

  it('firefox flag only when browser=firefox AND toggle on', () => {
    const onFirefox = buildDefaultToggles(true);
    expect(buildInstallFlags('firefox', onFirefox)).toContain('--firefox');
    expect(buildInstallFlags('chromium', onFirefox)).not.toContain('--firefox');

    const offFirefox = { ...buildDefaultToggles(true), firefox: false };
    expect(buildInstallFlags('firefox', offFirefox)).not.toContain('--firefox');
  });

  it('all optional off → only --no-searxng (chromium still installs via runWarmup)', () => {
    const toggles = {
      ...buildDefaultToggles(false),
      searxng: false,
      reranker: false,
      embeddings: false,
    };
    const flags = buildInstallFlags('chromium', toggles);
    expect(flags).toEqual(['--no-searxng']);
  });
});
