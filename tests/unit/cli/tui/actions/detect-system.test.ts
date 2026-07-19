import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const checkNodeMock = vi.hoisted(() => vi.fn());
const checkPythonMock = vi.hoisted(() => vi.fn());
const checkDockerMock = vi.hoisted(() => vi.fn());
const checkDiskSpaceMock = vi.hoisted(() => vi.fn());

vi.mock('../../../../../src/cli/tui/system-check.js', () => ({
  checkNode: checkNodeMock,
  checkPython: checkPythonMock,
  checkDocker: checkDockerMock,
  checkDiskSpace: checkDiskSpaceMock,
}));

import { detectSystem } from '../../../../../src/cli/tui/actions/detect-system.js';

beforeEach(() => {
  checkNodeMock.mockReturnValue({ ok: true, version: '22.0.0' });
  checkPythonMock.mockReturnValue({ ok: true, version: '3.12.0', binary: 'python3' });
  checkDockerMock.mockReturnValue({ ok: true, version: '25.0.0' });
  checkDiskSpaceMock.mockResolvedValue({ ok: true, freeMb: 50000 });
});

afterEach(() => vi.clearAllMocks());

describe('detectSystem', () => {
  it('returns hardFailure=false when node and python pass', async () => {
    const r = await detectSystem();
    expect(r.hardFailure).toBe(false);
    expect(r.nodeOk).toBe(true);
    expect(r.pythonOk).toBe(true);
  });

  it('returns hardFailure=true when node fails', async () => {
    checkNodeMock.mockReturnValue({ ok: false, version: '18.0.0', message: 'too old' });
    const r = await detectSystem();
    expect(r.hardFailure).toBe(true);
    expect(r.nodeOk).toBe(false);
    expect(r.nodeMessage).toBe('too old');
  });

  it('does NOT hard-fail when python is missing (optional — search-engine sidecar only)', async () => {
    // WHY: Python is not required for wigolo's core; only the opt-in search-engine
    // sidecar uses it, and warmup degrades to core without it. A missing Python
    // must not block the setup wizard.
    checkPythonMock.mockReturnValue({ ok: false, message: 'not found' });
    const r = await detectSystem();
    expect(r.hardFailure).toBe(false);
    expect(r.pythonOk).toBe(false);
  });

  it('surfaces pythonBinary and version', async () => {
    checkPythonMock.mockReturnValue({ ok: true, version: '3.11.5', binary: 'python3' });
    const r = await detectSystem();
    expect(r.pythonBinary).toBe('python3');
    expect(r.pythonVersion).toBe('3.11.5');
  });

  it('disk not ok does not trigger hardFailure', async () => {
    checkDiskSpaceMock.mockResolvedValue({ ok: false, freeMb: 100, message: 'low' });
    const r = await detectSystem();
    expect(r.hardFailure).toBe(false);
    expect(r.diskOk).toBe(false);
    expect(r.diskMessage).toBe('low');
  });
});
