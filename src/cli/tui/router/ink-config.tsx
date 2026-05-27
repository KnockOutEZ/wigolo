/**
 * ink-config — entry point for `wigolo config` and `wigolo dashboard`.
 *
 * Mounts the main-menu router that lets users reach every wizard screen
 * standalone (reconfigure mode). This is the §5.1 screen-stack router.
 *
 * HARD invariant: this function is only called from config/dashboard CLI
 * commands, NEVER from the MCP stdio path (which calls startServer directly).
 */
import React, { useState, useCallback } from 'react';
import { render, useApp, Box, Text } from 'ink';
import { enableTuiMode } from '../utils/suppress-logs.js';
import { Banner } from '../components/Banner.js';
import { MainMenu } from '../components/MainMenu.js';
import { SystemCheck } from '../components/SystemCheck.js';
import { BrowserSelect } from '../components/BrowserSelect.js';
import { ReviewToggles } from '../components/ReviewToggles.js';
import { InstallProgress } from '../components/InstallProgress.js';
import { Verification } from '../components/Verification.js';
import { AgentSelect } from '../components/AgentSelect.js';
import { EnvEditor } from '../components/EnvEditor.js';
import { getConfig } from '../../../config.js';
import type { ScreenId } from '../actions/index.js';
import type { BrowserChoice } from '../components/BrowserSelect.js';
import type { ToggleMap } from '../actions/index.js';

type ConfigScreen = ScreenId;

interface ScreenState {
  current: ConfigScreen;
  history: ConfigScreen[];
}

function WigoloConfig() {
  const { exit } = useApp();
  const config = getConfig();

  const [screenState, setScreenState] = useState<ScreenState>({
    current: 'main-menu',
    history: [],
  });
  const [bannerDone, setBannerDone] = useState(false);
  const [browser, setBrowser] = useState<BrowserChoice>('chromium');
  const [toggles, setToggles] = useState<ToggleMap | null>(null);

  const navigate = useCallback((screen: ConfigScreen) => {
    setScreenState((prev) => ({
      current: screen,
      history: [...prev.history, prev.current],
    }));
  }, []);

  const goBack = useCallback(() => {
    setScreenState((prev) => {
      if (prev.history.length === 0) {
        exit();
        return prev;
      }
      const history = [...prev.history];
      const current = history.pop()!;
      return { current, history };
    });
  }, [exit]);

  const handleBannerDone = useCallback(() => {
    setBannerDone(true);
  }, []);

  if (!bannerDone) {
    return <Banner onComplete={handleBannerDone} />;
  }

  const screen = screenState.current;

  return (
    <Box flexDirection="column">
      {screen === 'main-menu' && (
        <MainMenu onNavigate={navigate} onExit={() => exit()} />
      )}

      {screen === 'syscheck' && (
        <SystemCheck
          onComplete={() => goBack()}
          onFail={() => goBack()}
        />
      )}

      {screen === 'browser' && (
        <BrowserSelect
          onComplete={(b: BrowserChoice) => {
            setBrowser(b);
            goBack();
          }}
        />
      )}

      {screen === 'review' && (
        <ReviewToggles
          browser={browser}
          onComplete={(t: ToggleMap) => {
            setToggles(t);
            goBack();
          }}
        />
      )}

      {screen === 'install' && (
        <InstallProgress
          browser={browser}
          onComplete={() => goBack()}
          toggles={toggles ?? undefined}
        />
      )}

      {screen === 'verify' && (
        <Verification
          dataDir={config.dataDir}
          onComplete={() => goBack()}
        />
      )}

      {screen === 'agents' && (
        <AgentSelect
          onComplete={() => goBack()}
        />
      )}

      {screen === 'env-editor' && (
        <EnvEditor
          onComplete={() => goBack()}
          onSkip={() => goBack()}
        />
      )}

      {screen === 'summary' && (
        <Box paddingX={2}>
          <Text color="green" bold>{'✓'} Reconfiguration complete</Text>
        </Box>
      )}

      {/* show back hint for non-menu screens */}
      {screen !== 'main-menu' && (
        <Box paddingX={2} marginTop={1}>
          <Text dimColor>Press esc or q to return to menu</Text>
        </Box>
      )}
    </Box>
  );
}

export async function runInkConfig(): Promise<void> {
  enableTuiMode();
  const { waitUntilExit } = render(<WigoloConfig />);
  await waitUntilExit();
}
