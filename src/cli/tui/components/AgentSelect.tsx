import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { Spinner } from '@inkjs/ui';
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

interface ChecklistItem {
  id: string;
  label: string;
  checked: boolean;
}

function CheckboxList({
  items,
  onSubmit,
}: {
  items: ChecklistItem[];
  onSubmit: (selectedIds: string[]) => void;
}) {
  const [cursor, setCursor] = useState(0);
  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(items.filter((i) => i.checked).map((i) => i.id)),
  );
  const [error, setError] = useState('');

  useInput((input, key) => {
    if (key.upArrow) {
      setCursor((c) => (c > 0 ? c - 1 : items.length - 1));
      setError('');
    } else if (key.downArrow) {
      setCursor((c) => (c < items.length - 1 ? c + 1 : 0));
      setError('');
    } else if (input === ' ') {
      const id = items[cursor]!.id;
      setChecked((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      setError('');
    } else if (key.return) {
      const selected = items.filter((i) => checked.has(i.id)).map((i) => i.id);
      if (selected.length === 0) {
        setError('Select at least one agent');
        return;
      }
      onSubmit(selected);
    }
  });

  return (
    <Box flexDirection="column">
      {items.map((item, i) => {
        const isFocused = i === cursor;
        const isChecked = checked.has(item.id);
        return (
          <Text key={item.id}>
            {isFocused ? <Text color="cyan">{'❯ '}</Text> : '  '}
            {isChecked
              ? <Text color="green">{'[✓] '}</Text>
              : <Text dimColor>{'[ ] '}</Text>
            }
            <Text bold={isFocused}>{item.label}</Text>
          </Text>
        );
      })}
      {error && (
        <Box marginTop={1}><Text color="red">  {error}</Text></Box>
      )}
    </Box>
  );
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

  const checklistItems: ChecklistItem[] = agents.map((a) => ({
    id: a.id,
    label: a.detected ? `${a.displayName} (detected)` : a.displayName,
    checked: a.id === 'claude-code' && a.detected,
  }));

  async function handleSubmit(selectedIds: string[]) {
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
      <Text dimColor>↑/↓ navigate · space toggle · enter confirm</Text>
      <Box marginTop={1}>
        <CheckboxList items={checklistItems} onSubmit={handleSubmit} />
      </Box>
    </Box>
  );
}
