import { describe, expect, it, vi, beforeEach } from 'vitest';

const { execSyncMock, existsSyncMock } = vi.hoisted(() => ({
  execSyncMock: vi.fn(),
  existsSyncMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execSync: execSyncMock,
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, existsSync: existsSyncMock };
});

vi.mock('../../../../src/python-env.js', () => ({
  getPythonBin: () => '/fake/python',
}));

vi.mock('../../../../src/config.js', () => ({
  getConfig: () => ({ rerankerModel: 'bge-reranker-v2-m3' }),
}));

vi.mock('../../../../src/search/reranker/models.js', () => ({
  resolveModelId: (id: string) => id,
}));

import { probePythonPackages } from '../../../../src/cli/tui/status-python.js';

beforeEach(() => {
  execSyncMock.mockReset();
  existsSyncMock.mockReset();
});

describe('probePythonPackages', () => {
  it('marks each package ok when every import/file check succeeds', () => {
    execSyncMock.mockReturnValue(Buffer.from(''));
    existsSyncMock.mockReturnValue(true);

    const result = probePythonPackages('/tmp/data');

    expect(result.reranker).toBe('ok');
    expect(result.trafilatura).toBe('ok');
    expect(result.embeddings).toBe('ok');
  });

  it('marks each package missing when its probe fails', () => {
    execSyncMock.mockImplementation(() => { throw new Error('ModuleNotFoundError'); });
    existsSyncMock.mockReturnValue(false);

    const result = probePythonPackages('/tmp/data');

    expect(result.reranker).toBe('missing');
    expect(result.trafilatura).toBe('missing');
    expect(result.embeddings).toBe('missing');
  });

  it('marks reranker missing but trafilatura ok (per-package failure isolation)', () => {
    existsSyncMock.mockReturnValue(false);
    execSyncMock.mockImplementation(() => Buffer.from(''));

    const result = probePythonPackages('/tmp/data');

    expect(result.reranker).toBe('missing');
    expect(result.trafilatura).toBe('ok');
    expect(result.embeddings).toBe('ok');
  });
});
