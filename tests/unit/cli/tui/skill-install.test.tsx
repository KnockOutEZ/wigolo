import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import { SkillInstall } from '../../../../src/cli/tui/components/SkillInstall.js';

const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockWriteFileSync = vi.fn();
const mockMkdirSync = vi.fn();
const mockAppendFileSync = vi.fn();

vi.mock('node:fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
  mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
  appendFileSync: (...args: unknown[]) => mockAppendFileSync(...args),
}));

vi.mock('node:os', () => ({
  homedir: () => '/fake/home',
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  mockExistsSync.mockReset();
  mockReadFileSync.mockReset();
  mockWriteFileSync.mockReset();
  mockMkdirSync.mockReset();
  mockAppendFileSync.mockReset();
});

function setupSkillMdFound() {
  mockExistsSync.mockImplementation((path: string) => {
    if (path.endsWith('SKILL.md')) return true;
    return false;
  });
  mockReadFileSync.mockImplementation((path: string) => {
    if (path.endsWith('SKILL.md')) return '# wigolo skill content';
    throw new Error('not found');
  });
}

describe('SkillInstall', () => {
  it('renders header when agents provided', async () => {
    setupSkillMdFound();
    const { lastFrame } = render(
      <SkillInstall agents={['claude-code']} onComplete={() => {}} />,
    );
    await new Promise((r) => setTimeout(r, 100));
    const frame = lastFrame()!;
    expect(frame).toContain('Installing agent skills');
  });

  it('writes skill file for claude-code', async () => {
    setupSkillMdFound();
    const onComplete = vi.fn();
    render(<SkillInstall agents={['claude-code']} onComplete={onComplete} />);
    await new Promise((r) => setTimeout(r, 500));

    expect(onComplete).toHaveBeenCalled();
    const results = onComplete.mock.calls[0][0];
    expect(results[0].status).toBe('installed');
    expect(results[0].detail).toContain('.claude/commands/wigolo.md');

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining('.claude/commands/wigolo.md'),
      expect.any(String),
    );
  });

  it('writes instruction snippet to CLAUDE.md for claude-code', async () => {
    setupSkillMdFound();
    render(<SkillInstall agents={['claude-code']} onComplete={() => {}} />);
    await new Promise((r) => setTimeout(r, 100));

    // CLAUDE.md doesn't exist -> writeFileSync with snippet
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining('CLAUDE.md'),
      expect.stringContaining('Wigolo'),
    );
  });

  it('writes skill file for cursor', async () => {
    setupSkillMdFound();
    const onComplete = vi.fn();
    render(<SkillInstall agents={['cursor']} onComplete={onComplete} />);
    await new Promise((r) => setTimeout(r, 500));

    const results = onComplete.mock.calls[0][0];
    expect(results[0].status).toBe('installed');
    expect(results[0].detail).toContain('.cursor/rules/wigolo.md');
  });

  it('calls onComplete after processing', async () => {
    setupSkillMdFound();
    const onComplete = vi.fn();
    render(<SkillInstall agents={['claude-code']} onComplete={onComplete} />);
    await new Promise((r) => setTimeout(r, 500));
    expect(onComplete).toHaveBeenCalled();
  });

  it('calls onComplete immediately with empty agents', async () => {
    const onComplete = vi.fn();
    render(<SkillInstall agents={[]} onComplete={onComplete} />);
    await new Promise((r) => setTimeout(r, 500));
    expect(onComplete).toHaveBeenCalled();
  });

  it('skips instruction snippet if marker already present', async () => {
    mockExistsSync.mockImplementation((path: string) => {
      if (path.endsWith('SKILL.md')) return true;
      if (path.endsWith('CLAUDE.md')) return true;
      return false;
    });
    mockReadFileSync.mockImplementation((path: string) => {
      if (path.endsWith('SKILL.md')) return '# wigolo skill content';
      if (path.endsWith('CLAUDE.md')) return '# existing\n<!-- @staticn0va/wigolo -->';
      throw new Error('not found');
    });

    render(<SkillInstall agents={['claude-code']} onComplete={() => {}} />);
    await new Promise((r) => setTimeout(r, 100));

    expect(mockAppendFileSync).not.toHaveBeenCalled();
  });
});
