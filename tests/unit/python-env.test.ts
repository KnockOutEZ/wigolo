import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfig } from '../../src/config.js';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, existsSync: vi.fn() };
});

import { existsSync } from 'node:fs';
import { getPythonBin } from '../../src/python-env.js';

describe('getPythonBin', () => {
  beforeEach(() => { resetConfig(); vi.clearAllMocks(); });
  afterEach(() => { resetConfig(); delete process.env.WIGOLO_DATA_DIR; });

  it('returns venv python when venv exists', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    const bin = getPythonBin('/tmp/wigolo');
    expect(bin).toBe('/tmp/wigolo/searxng/venv/bin/python');
  });

  it('falls back to system python3 when venv does not exist', () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const bin = getPythonBin('/tmp/wigolo');
    expect(bin).toBe('python3');
  });

  it('resolves dataDir from config when argument omitted', () => {
    vi.mocked(existsSync).mockImplementation((p) =>
      String(p) === '/tmp/from-config/searxng/venv/bin/python',
    );
    process.env.WIGOLO_DATA_DIR = '/tmp/from-config';
    const bin = getPythonBin();
    expect(bin).toBe('/tmp/from-config/searxng/venv/bin/python');
  });

  it('returns python3 fallback when venv python missing under config dataDir', () => {
    vi.mocked(existsSync).mockReturnValue(false);
    process.env.WIGOLO_DATA_DIR = '/tmp/no-venv';
    const bin = getPythonBin();
    expect(bin).toBe('python3');
  });
});
