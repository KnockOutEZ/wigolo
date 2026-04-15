import { describe, expect, it, vi, beforeEach } from 'vitest';

const { execSyncMock } = vi.hoisted(() => ({
  execSyncMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execSync: execSyncMock,
}));

vi.mock('../../../../src/python-env.js', () => ({
  getPythonBin: () => '/fake/python',
}));

import { probePythonPackages } from '../../../../src/cli/tui/status-python.js';

beforeEach(() => {
  execSyncMock.mockReset();
});

describe('probePythonPackages', () => {
  it('marks each package ok when every import succeeds', () => {
    execSyncMock.mockReturnValue(Buffer.from(''));

    const result = probePythonPackages('/tmp/data');

    expect(result.flashrank).toBe('ok');
    expect(result.trafilatura).toBe('ok');
    expect(result.embeddings).toBe('ok');
  });

  it('marks each package missing when its import throws', () => {
    execSyncMock.mockImplementation(() => { throw new Error('ModuleNotFoundError'); });

    const result = probePythonPackages('/tmp/data');

    expect(result.flashrank).toBe('missing');
    expect(result.trafilatura).toBe('missing');
    expect(result.embeddings).toBe('missing');
  });

  it('marks flashrank missing but trafilatura ok (per-package failure isolation)', () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.includes('import flashrank')) throw new Error('no');
      return Buffer.from('');
    });

    const result = probePythonPackages('/tmp/data');

    expect(result.flashrank).toBe('missing');
    expect(result.trafilatura).toBe('ok');
    expect(result.embeddings).toBe('ok');
  });
});
