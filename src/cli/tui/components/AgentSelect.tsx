import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { MultiSelect, Spinner } from '@inkjs/ui';
import { useAgentDetect } from '../hooks/useAgentDetect.js';
import { applyConfigs } from '../config-writer.js';
import type { AgentId, DetectedAgent } from '../agents.js';

export interface AgentResult {
  id: string;
  displayName: string;
  ok: boolean;
  message?: string;
}

interface AgentSelectProps {
  onComplete: (selectedIds: AgentId[], results: AgentResult[]) => void;
}

function buildOptions(agents: DetectedAgent[]) {
  return agents.map((a) => ({
    label: a.detected ? `${a.displayName} (detected)` : a.displayName,
    value: a.id,
  }));
}

export function AgentSelect({ onComplete }: AgentSelectProps) {
  const { agents, done: detectDone } = useAgentDetect();
  const [configuring, setConfiguring] = useState(false);
  const [results, setResults] = useState<AgentResult[]>([]);
  const [configDone, setConfigDone] = useState(false);

  useEffect(() => {
    if (configDone) {
      const ids = results.filter((r) => r.ok).map((r) => r.id as AgentId);
      const timer = setTimeout(() => onComplete(ids, results), 400);
      return () => clearTimeout(timer);
    }
  }, [configDone, results, onComplete]);

  if (!detectDone) {
    return (
      <Box paddingX={2}>
        <Spinner label="Detecting AI tools..." />
      </Box>
    );
  }

  if (configuring) {
    return (
      <Box flexDirection="column" paddingX={2}>
        <Text bold>Configuring agents...</Text>
        <Box flexDirection="column" marginTop={1}>
          {results.map((r) => (
            <Text key={r.id}>
              {'  '}
              {r.ok
                ? <Text color="green">{'✓'}</Text>
                : <Text color="red">{'✗'}</Text>
              }
              {' '}{r.displayName}
              {r.message && !r.ok ? <Text color="red"> — {r.message}</Text> : null}
            </Text>
          ))}
          {!configDone && (
            <Box marginTop={1}>
              <Spinner label="Writing configs..." />
            </Box>
          )}
        </Box>
      </Box>
    );
  }

  const options = buildOptions(agents);
  const defaultSelected = agents.filter((a) => a.detected).map((a) => a.id);

  async function handleSubmit(selectedIds: string[]) {
    if (selectedIds.length === 0) {
      onComplete([], []);
      return;
    }
    setConfiguring(true);
    const configResults = await applyConfigs(agents, selectedIds as AgentId[]);
    const mapped: AgentResult[] = configResults.map((r) => ({
      id: r.id,
      displayName: r.displayName,
      ok: r.ok,
      message: r.message,
    }));
    setResults(mapped);
    setConfigDone(true);
  }

  return (
    <Box flexDirection="column" paddingX={2}>
      <Text bold>Connect to AI Tools</Text>
      <Text dimColor>Select agents to configure (space = toggle, enter = confirm)</Text>
      <Box marginTop={1}>
        <MultiSelect
          options={options}
          defaultValue={defaultSelected}
          onSubmit={handleSubmit}
        />
      </Box>
    </Box>
  );
}
