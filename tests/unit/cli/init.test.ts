import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/cli/tui/system-check.js', () => ({
  runSystemCheck: vi.fn(),
}));

vi.mock('../../../src/cli/tui/banner.js', () => ({
  renderBanner: vi.fn(() => 'BANNER\n'),
}));

vi.mock('../../../src/cli/tui/version.js', () => ({
  getPackageVersion: vi.fn(() => '0.6.3'),
}));

import { runInit } from '../../../src/cli/init.js';
import { runSystemCheck } from '../../../src/cli/tui/system-check.js';

function capture(): { stdout: string[]; stderr: string[]; restore: () => void } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  (process.stdout.write as any) = (chunk: any) => { stdout.push(String(chunk)); return true; };
  (process.stderr.write as any) = (chunk: any) => { stderr.push(String(chunk)); return true; };
  return {
    stdout,
    stderr,
    restore: () => {
      process.stdout.write = origOut as any;
      process.stderr.write = origErr as any;
    },
  };
}

describe('runInit', () => {
  beforeEach(() => vi.clearAllMocks());

  it('exits 0 on all-ok system', async () => {
    vi.mocked(runSystemCheck).mockResolvedValue({
      node: { ok: true, version: '22.14.0' },
      python: { ok: true, binary: 'python3', version: '3.12.5' },
      docker: { ok: true, version: '29.4.0' },
      disk: { ok: true, freeMb: 50000 },
      hardFailure: false,
    });
    const cap = capture();
    try {
      const code = await runInit([]);
      expect(code).toBe(0);
      const out = cap.stdout.join('');
      expect(out).toContain('BANNER');
      expect(out).toContain('Node');
      expect(out).toContain('22.14.0');
      expect(out).toContain('Python');
      expect(out).toContain('3.12.5');
      expect(out).toContain('Docker');
      expect(out).toContain('warmup');
    } finally {
      cap.restore();
    }
  });

  it('exits 1 when Node is too old', async () => {
    vi.mocked(runSystemCheck).mockResolvedValue({
      node: { ok: false, version: '18.0.0', message: 'requires Node 20+' },
      python: { ok: true, binary: 'python3', version: '3.12.5' },
      docker: { ok: false },
      disk: { ok: true, freeMb: 50000 },
      hardFailure: true,
    });
    const cap = capture();
    try {
      const code = await runInit([]);
      expect(code).toBe(1);
      const out = cap.stdout.join('');
      expect(out).toMatch(/requires Node 20/i);
    } finally {
      cap.restore();
    }
  });

  it('exits 1 when Python 3 is missing', async () => {
    vi.mocked(runSystemCheck).mockResolvedValue({
      node: { ok: true, version: '22.14.0' },
      python: { ok: false, message: 'Python 3 not found.' },
      docker: { ok: false },
      disk: { ok: true, freeMb: 50000 },
      hardFailure: true,
    });
    const cap = capture();
    try {
      const code = await runInit([]);
      expect(code).toBe(1);
      const out = cap.stdout.join('');
      expect(out).toMatch(/python/i);
      expect(out).toMatch(/python\.org|brew install/i);
    } finally {
      cap.restore();
    }
  });

  it('warns but exits 0 when Docker is missing (optional)', async () => {
    vi.mocked(runSystemCheck).mockResolvedValue({
      node: { ok: true, version: '22.14.0' },
      python: { ok: true, binary: 'python3', version: '3.12.5' },
      docker: { ok: false },
      disk: { ok: true, freeMb: 50000 },
      hardFailure: false,
    });
    const cap = capture();
    try {
      const code = await runInit([]);
      expect(code).toBe(0);
      const out = cap.stdout.join('');
      expect(out).toMatch(/docker.*optional|optional.*docker/i);
    } finally {
      cap.restore();
    }
  });

  it('warns but exits 0 when disk space is low', async () => {
    vi.mocked(runSystemCheck).mockResolvedValue({
      node: { ok: true, version: '22.14.0' },
      python: { ok: true, binary: 'python3', version: '3.12.5' },
      docker: { ok: true, version: '29.4.0' },
      disk: { ok: false, freeMb: 200, message: 'only 200 MB free' },
      hardFailure: false,
    });
    const cap = capture();
    try {
      const code = await runInit([]);
      expect(code).toBe(0);
      const out = cap.stdout.join('');
      expect(out).toMatch(/200 MB|disk/i);
    } finally {
      cap.restore();
    }
  });

  it('writes banner to stdout not stderr', async () => {
    vi.mocked(runSystemCheck).mockResolvedValue({
      node: { ok: true, version: '22.14.0' },
      python: { ok: true, binary: 'python3', version: '3.12.5' },
      docker: { ok: true, version: '29.4.0' },
      disk: { ok: true, freeMb: 50000 },
      hardFailure: false,
    });
    const cap = capture();
    try {
      await runInit([]);
      expect(cap.stdout.join('')).toContain('BANNER');
      expect(cap.stderr.join('')).not.toContain('BANNER');
    } finally {
      cap.restore();
    }
  });

  it('accepts a flags array without crashing on unknown flags', async () => {
    vi.mocked(runSystemCheck).mockResolvedValue({
      node: { ok: true, version: '22.14.0' },
      python: { ok: true, binary: 'python3', version: '3.12.5' },
      docker: { ok: true, version: '29.4.0' },
      disk: { ok: true, freeMb: 50000 },
      hardFailure: false,
    });
    const cap = capture();
    try {
      const code = await runInit(['--some-future-flag', 'value']);
      expect(code).toBe(0);
    } finally {
      cap.restore();
    }
  });
});
