import React, { useState, useCallback } from 'react';
import { render, useApp, Box, Text, Static } from 'ink';
import { enableTuiMode } from './utils/suppress-logs.js';
import { Banner } from './components/Banner.js';
import { SystemCheck } from './components/SystemCheck.js';
import { BrowserSelect, type BrowserChoice } from './components/BrowserSelect.js';
import { InstallProgress } from './components/InstallProgress.js';
import { Verification } from './components/Verification.js';
import { AgentSelect, type AgentResult } from './components/AgentSelect.js';
import { SkillInstall, type SkillResultInfo } from './components/SkillInstall.js';
import { Summary } from './components/Summary.js';
import { saveInitConfig } from './utils/config-writer.js';
import { getConfig } from '../../config.js';
import type { AgentId } from './agents.js';
import type { CheckItem } from './hooks/useSystemCheck.js';
import type { InstallItem } from './hooks/useInstall.js';
import type { VerifyItem } from './hooks/useVerify.js';

type Phase = 'banner' | 'syscheck' | 'browser' | 'install' | 'verify' | 'agents' | 'skills' | 'done';

// --- Compact summaries for completed phases ---

function CompactSysCheck({ checks }: { checks: CheckItem[] }) {
  const passed = checks.filter((c) => c.status === 'pass').length;
  const failed = checks.filter((c) => c.status === 'fail').length;
  return (
    <Box paddingX={2}>
      <Text>
        <Text color="green" bold>{'✓'}</Text>
        <Text bold> System </Text>
        <Text dimColor>
          {passed} passed{failed > 0 ? `, ${failed} failed` : ''}
          {' — '}
          {checks.filter((c) => c.status === 'pass' || c.status === 'optional')
            .map((c) => `${c.label} ${c.detail}`)
            .join(', ')}
        </Text>
      </Text>
    </Box>
  );
}

function CompactBrowser({ browser }: { browser: BrowserChoice }) {
  const names: Record<BrowserChoice, string> = { lightpanda: 'Lightpanda', chromium: 'Chromium', firefox: 'Firefox' };
  return (
    <Box paddingX={2}>
      <Text>
        <Text color="green" bold>{'✓'}</Text>
        <Text bold> Browser </Text>
        <Text dimColor>{names[browser]} selected</Text>
      </Text>
    </Box>
  );
}

function CompactInstall({ items }: { items: InstallItem[] }) {
  const ok = items.filter((i) => i.status === 'done').length;
  const fail = items.filter((i) => i.status === 'failed').length;
  const totalTime = items.reduce((sum, i) => sum + (i.timeMs ?? 0), 0);
  return (
    <Box paddingX={2}>
      <Text>
        <Text color={fail > 0 ? 'yellow' : 'green'} bold>{fail > 0 ? '!' : '✓'}</Text>
        <Text bold> Install </Text>
        <Text dimColor>
          {ok} installed{fail > 0 ? `, ${fail} failed` : ''}
          {' — '}{(totalTime / 1000).toFixed(1)}s total
        </Text>
      </Text>
    </Box>
  );
}

function CompactVerify({ items }: { items: VerifyItem[] }) {
  const ok = items.filter((i) => i.status === 'pass').length;
  const fail = items.filter((i) => i.status === 'fail').length;
  return (
    <Box paddingX={2}>
      <Text>
        <Text color={fail > 0 ? 'yellow' : 'green'} bold>{fail > 0 ? '!' : '✓'}</Text>
        <Text bold> Verify </Text>
        <Text dimColor>
          {ok} passed{fail > 0 ? `, ${fail} warnings` : ''} —{' '}
          {items.filter((i) => i.status === 'pass').map((i) => i.detail).filter(Boolean).join(', ')}
        </Text>
      </Text>
    </Box>
  );
}


function CompactAgents({ results }: { results: AgentResult[] }) {
  if (results.length === 0) {
    return (
      <Box paddingX={2}>
        <Text>
          <Text dimColor bold>{'–'}</Text>
          <Text bold> Agents </Text>
          <Text dimColor>none selected</Text>
        </Text>
      </Box>
    );
  }
  const ok = results.filter((r) => r.ok);
  const fail = results.filter((r) => !r.ok);
  return (
    <Box paddingX={2}>
      <Text>
        <Text color={fail.length > 0 ? 'yellow' : 'green'} bold>{fail.length > 0 ? '!' : '✓'}</Text>
        <Text bold> MCP </Text>
        <Text dimColor>
          {ok.map((r) => r.displayName).join(', ')}
          {fail.length > 0 ? ` (${fail.length} failed)` : ''}
          {' — config written'}
        </Text>
      </Text>
    </Box>
  );
}


function CompactSkills({ results }: { results: SkillResultInfo[] }) {
  if (results.length === 0) return null;
  const installed = results.filter((r) => r.status === 'installed');
  const skipped = results.filter((r) => r.status === 'not_supported');
  return (
    <Box paddingX={2}>
      <Text>
        <Text color="green" bold>{'✓'}</Text>
        <Text bold> Skills </Text>
        <Text dimColor>
          {installed.length > 0
            ? installed.map((r) => r.name).join(', ')
            : 'none applicable'}
          {skipped.length > 0 ? ` (${skipped.length} use MCP instructions)` : ''}
        </Text>
      </Text>
    </Box>
  );
}

// --- Main app ---

interface CompletedItem {
  id: string;
  node: React.ReactNode;
}

function WigoloInit() {
  const [phase, setPhase] = useState<Phase>('banner');
  const [completed, setCompleted] = useState<CompletedItem[]>([]);
  const [browser, setBrowser] = useState<BrowserChoice>('lightpanda');
  const [agents, setAgents] = useState<AgentId[]>([]);

  // Results that components report back
  const [sysChecks, setSysChecks] = useState<CheckItem[]>([]);
  const [installItems, setInstallItems] = useState<InstallItem[]>([]);
  const [verifyItems, setVerifyItems] = useState<VerifyItem[]>([]);
  const [agentResults, setAgentResults] = useState<AgentResult[]>([]);
  const [skillResults, setSkillResults] = useState<SkillResultInfo[]>([]);

  const config = getConfig();
  const { exit } = useApp();

  const addCompleted = useCallback((id: string, node: React.ReactNode) => {
    setCompleted((prev) => [...prev, { id, node }]);
  }, []);

  // --- Phase transitions ---

  const handleBannerDone = useCallback(() => {
    setPhase('syscheck');
  }, []);

  const handleSysCheckDone = useCallback((checks: CheckItem[]) => {
    setSysChecks(checks);
    addCompleted('syscheck', <CompactSysCheck checks={checks} />);
    setPhase('browser');
  }, [addCompleted]);

  const handleSysFail = useCallback((checks: CheckItem[]) => {
    setSysChecks(checks);
    addCompleted('syscheck', <CompactSysCheck checks={checks} />);
    setTimeout(() => exit(new Error('System check failed')), 1500);
  }, [addCompleted, exit]);

  const handleBrowserDone = useCallback((b: BrowserChoice) => {
    setBrowser(b);
    saveInitConfig(config.dataDir, { defaultBrowser: b });
    addCompleted('browser', <CompactBrowser browser={b} />);
    setPhase('install');
  }, [config.dataDir, addCompleted]);

  const handleInstallDone = useCallback((items: InstallItem[]) => {
    setInstallItems(items);
    addCompleted('install', <CompactInstall items={items} />);
    setPhase('verify');
  }, [addCompleted]);

  const handleVerifyDone = useCallback((items: VerifyItem[]) => {
    setVerifyItems(items);
    addCompleted('verify', <CompactVerify items={items} />);
    setPhase('agents');
  }, [addCompleted]);

  const handleAgentsDone = useCallback((selectedIds: AgentId[], results: AgentResult[]) => {
    setAgents(selectedIds);
    setAgentResults(results);
    saveInitConfig(config.dataDir, {
      configuredAgents: selectedIds,
      lastInit: new Date().toISOString(),
    });
    addCompleted('agents', <CompactAgents results={results} />);
    setPhase('skills');
  }, [config.dataDir, addCompleted]);

  const handleSkillsDone = useCallback((results: SkillResultInfo[]) => {
    setSkillResults(results);
    if (results.length > 0) {
      addCompleted('skills', <CompactSkills results={results} />);
    }
    setPhase('done');
  }, [addCompleted]);

  return (
    <Box flexDirection="column">
      {/* Banner always at top */}
      {phase === 'banner' ? (
        <Banner onComplete={handleBannerDone} />
      ) : (
        <Banner onComplete={() => {}} />
      )}

      {/* Completed phases shown as compact summaries */}
      <Static items={completed}>
        {(item) => (
          <Box key={item.id}>{item.node}</Box>
        )}
      </Static>

      {/* Spacer between completed and active */}
      {phase !== 'banner' && phase !== 'done' && <Text> </Text>}

      {/* Active phase */}
      {phase === 'syscheck' && (
        <SystemCheck onComplete={handleSysCheckDone} onFail={handleSysFail} />
      )}
      {phase === 'browser' && (
        <BrowserSelect onComplete={handleBrowserDone} />
      )}
      {phase === 'install' && (
        <InstallProgress browser={browser} onComplete={handleInstallDone} />
      )}
      {phase === 'verify' && (
        <Verification dataDir={config.dataDir} onComplete={handleVerifyDone} />
      )}
      {phase === 'agents' && (
        <AgentSelect onComplete={handleAgentsDone} />
      )}
      {phase === 'skills' && (
        <SkillInstall agents={agents} onComplete={handleSkillsDone} />
      )}
      {phase === 'done' && (
        <Summary
          agentResults={agentResults}
          skillResults={skillResults}
          installItems={installItems}
          verifyItems={verifyItems}
        />
      )}
    </Box>
  );
}

export async function runInkInit(): Promise<void> {
  enableTuiMode();
  const { waitUntilExit } = render(<WigoloInit />);
  await waitUntilExit();
}
