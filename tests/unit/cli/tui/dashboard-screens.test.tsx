/**
 * Smoke render + delegation tests for the dashboard action screens that
 * still ship behind the SettingsHome action bar.
 *
 * Why: each dashboard .tsx must mount without throwing and delegate to the
 * correct action layer entry (no business logic in components). The tests
 * mock the actions layer (dynamic-imported inside the components) and
 * getConfig, then assert the screens render and call the right action after
 * their effects fire.
 *
 * Coverage is intentionally narrow — Dashboard and DashboardCleanup were
 * deleted because nothing reached them after the entry-router refactor;
 * the screens still wired into router/ink.tsx remain tested here.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';

const exportConfigMock = vi.hoisted(() => vi.fn());
const importConfigMock = vi.hoisted(() => vi.fn());
const uninstallMock = vi.hoisted(() => vi.fn());

vi.mock('../../../../src/cli/tui/actions/index.js', () => ({
  exportConfig: exportConfigMock,
  importConfig: importConfigMock,
  uninstall: uninstallMock,
}));

vi.mock('../../../../src/config.js', () => ({
  getConfig: vi.fn(() => ({ dataDir: '/tmp/wigolo-test-datadir' })),
}));

import { DashboardExport } from '../../../../src/cli/tui/components/DashboardExport.js';
import { DashboardUninstall } from '../../../../src/cli/tui/components/DashboardUninstall.js';

/** Wait for useEffect's dynamic import + async action to settle. */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 40));
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe('DashboardExport — smoke render + export/import delegation', () => {
  it('mounts without throwing', () => {
    expect(() => render(<DashboardExport onBack={() => {}} />)).not.toThrow();
  });

  it('shows the export and import menu options', () => {
    const { lastFrame } = render(<DashboardExport onBack={() => {}} />);
    const frame = lastFrame()!;
    expect(frame).toContain('Export config');
    expect(frame).toContain('Import config');
  });

  it('triggers exportConfig when the export option is selected', async () => {
    exportConfigMock.mockResolvedValue({ ok: true, path: '/x' });
    const { stdin } = render(<DashboardExport onBack={() => {}} />);
    await flush();
    // First menu item is 'export'; press enter.
    stdin.write('\r');
    await flush();
    expect(exportConfigMock).toHaveBeenCalledOnce();
  });

  it('triggers importConfig when the import option is selected', async () => {
    importConfigMock.mockResolvedValue({ ok: true });
    const { stdin } = render(<DashboardExport onBack={() => {}} />);
    await flush();
    // Move down to 'import', then enter. ink-testing-library decodes the
    // ANSI CSI sequence (ESC + '[B') into a `key.downArrow` event.
    stdin.write('[B');
    await flush();
    stdin.write('\r');
    await flush();
    expect(importConfigMock).toHaveBeenCalledOnce();
  });
});

describe('DashboardUninstall — smoke render + uninstall delegation', () => {
  it('mounts without throwing', () => {
    expect(() => render(<DashboardUninstall onBack={() => {}} />)).not.toThrow();
  });

  it('shows the confirmation prompt and does NOT auto-call uninstall', async () => {
    const { lastFrame } = render(<DashboardUninstall onBack={() => {}} />);
    await flush();
    const frame = lastFrame()!;
    expect(frame.toLowerCase()).toContain('uninstall');
    // No action until the user confirms.
    expect(uninstallMock).not.toHaveBeenCalled();
  });

  it('calls uninstall with confirmed:true only after the user types y', async () => {
    uninstallMock.mockResolvedValue({ ok: true, dataDirRemoved: true, agentResults: [] });
    const { stdin } = render(<DashboardUninstall onBack={() => {}} />);
    await flush();
    stdin.write('y');
    await flush();
    expect(uninstallMock).toHaveBeenCalledWith({
      dataDir: '/tmp/wigolo-test-datadir',
      confirmed: true,
    });
  });

  it('does NOT call uninstall when the user cancels with n', async () => {
    const onBack = vi.fn();
    const { stdin } = render(<DashboardUninstall onBack={onBack} />);
    await flush();
    stdin.write('n');
    await flush();
    expect(uninstallMock).not.toHaveBeenCalled();
    expect(onBack).toHaveBeenCalledOnce();
  });
});
