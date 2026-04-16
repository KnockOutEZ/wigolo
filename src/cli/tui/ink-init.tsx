import React, { useState, useCallback } from 'react';
import { render } from 'ink';
import { enableTuiMode } from './utils/suppress-logs.js';
import { Banner } from './components/Banner.js';
import { SystemCheck } from './components/SystemCheck.js';
import { BrowserSelect, type BrowserChoice } from './components/BrowserSelect.js';
import { InstallProgress } from './components/InstallProgress.js';
import { Verification } from './components/Verification.js';
import { AgentSelect } from './components/AgentSelect.js';
import { SkillInstall } from './components/SkillInstall.js';
import { Summary } from './components/Summary.js';
import { saveInitConfig } from './utils/config-writer.js';
import { getConfig } from '../../config.js';
import type { AgentId } from './agents.js';

type Screen = 'banner' | 'syscheck' | 'browser' | 'install' | 'verify' | 'agents' | 'skills' | 'done';

function WigoloInit() {
  const [screen, setScreen] = useState<Screen>('banner');
  const [browser, setBrowser] = useState<BrowserChoice>('lightpanda');
  const [agents, setAgents] = useState<AgentId[]>([]);
  const config = getConfig();

  const goSyscheck = useCallback(() => setScreen('syscheck'), []);
  const goBrowser = useCallback(() => setScreen('browser'), []);
  const goInstall = useCallback(() => setScreen('install'), []);
  const goVerify = useCallback(() => setScreen('verify'), []);
  const goAgents = useCallback(() => setScreen('agents'), []);
  const goSkills = useCallback(() => setScreen('skills'), []);
  const goDone = useCallback(() => setScreen('done'), []);

  const handleBrowser = useCallback((b: BrowserChoice) => {
    setBrowser(b);
    saveInitConfig(config.dataDir, { defaultBrowser: b });
    setScreen('install');
  }, [config.dataDir]);

  const handleAgents = useCallback((selected: AgentId[]) => {
    setAgents(selected);
    saveInitConfig(config.dataDir, {
      configuredAgents: selected,
      lastInit: new Date().toISOString(),
    });
    setScreen('skills');
  }, [config.dataDir]);

  const handleSysFail = useCallback(() => {
    // Hard failure — exit after showing errors
    setTimeout(() => process.exit(1), 1000);
  }, []);

  switch (screen) {
    case 'banner':
      return <Banner onComplete={goSyscheck} />;
    case 'syscheck':
      return <SystemCheck onComplete={goBrowser} onFail={handleSysFail} />;
    case 'browser':
      return <BrowserSelect onComplete={handleBrowser} />;
    case 'install':
      return <InstallProgress browser={browser} onComplete={goVerify} />;
    case 'verify':
      return <Verification dataDir={config.dataDir} onComplete={goAgents} />;
    case 'agents':
      return <AgentSelect onComplete={handleAgents} />;
    case 'skills':
      return <SkillInstall agents={agents} onComplete={goDone} />;
    case 'done':
      return <Summary />;
  }
}

export function runInkInit(): void {
  enableTuiMode();
  const { waitUntilExit } = render(<WigoloInit />);
  waitUntilExit().then(() => {
    process.exit(0);
  });
}
