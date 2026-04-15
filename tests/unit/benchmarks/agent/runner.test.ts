import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  loadTasks,
  loadExpected,
  filterTasks,
  runAgentBenchmark,
} from '../../../../benchmarks/agent/runner.js';
import type { AgentTask } from '../../../../benchmarks/agent/types.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: vi.fn(),
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
});

import { readFileSync, existsSync } from 'node:fs';

const mockReadFileSync = vi.mocked(readFileSync);
const mockExistsSync = vi.mocked(existsSync);

beforeEach(() => {
  vi.clearAllMocks();
});

const sampleTasks = {
  version: '1.0.0',
  tasks: [
    { id: 't1', type: 'fact-lookup', description: 'desc1', query: 'q1', tags: ['ts'] },
    { id: 't2', type: 'multi-step-research', description: 'desc2', query: 'q2' },
    { id: 't3', type: 'comparison', description: 'desc3', query: 'q3', tags: ['perf'] },
  ],
};

const sampleExpected = {
  version: '1.0.0',
  outputs: [
    { taskId: 't1', facts: [{ taskId: 't1', fact: 'test', required: true }] },
    { taskId: 't2', facts: [{ taskId: 't2', fact: 'result', required: true }] },
  ],
};

describe('loadTasks', () => {
  it('loads and parses tasks JSON', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify(sampleTasks));
    const tasks = loadTasks('/path');
    expect(tasks).toHaveLength(3);
    expect(tasks[0].id).toBe('t1');
  });

  it('throws for invalid JSON', () => {
    mockReadFileSync.mockReturnValue('bad');
    expect(() => loadTasks('/path')).toThrow();
  });

  it('throws for missing tasks field', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ version: '1.0.0' }));
    expect(() => loadTasks('/path')).toThrow();
  });

  it('throws for empty tasks', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ tasks: [] }));
    expect(() => loadTasks('/path')).toThrow();
  });
});

describe('loadExpected', () => {
  it('loads and flattens expected facts', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify(sampleExpected));
    const facts = loadExpected('/path');
    expect(facts.length).toBeGreaterThan(0);
    expect(facts[0].taskId).toBe('t1');
  });

  it('throws for invalid JSON', () => {
    mockReadFileSync.mockReturnValue('bad');
    expect(() => loadExpected('/path')).toThrow();
  });

  it('throws for missing outputs field', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ version: '1.0.0' }));
    expect(() => loadExpected('/path')).toThrow();
  });
});

describe('filterTasks', () => {
  const tasks = sampleTasks.tasks as AgentTask[];

  it('returns all when no filter', () => {
    expect(filterTasks(tasks)).toHaveLength(3);
  });

  it('filters by task type', () => {
    const filtered = filterTasks(tasks, 'fact-lookup');
    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe('t1');
  });

  it('filters by ID', () => {
    const filtered = filterTasks(tasks, 't2');
    expect(filtered).toHaveLength(1);
  });

  it('filters by tag', () => {
    const filtered = filterTasks(tasks, 'ts');
    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe('t1');
  });

  it('returns empty for non-matching filter', () => {
    expect(filterTasks(tasks, 'nonexistent')).toHaveLength(0);
  });
});

describe('runAgentBenchmark', () => {
  it('throws when tasks path does not exist', async () => {
    mockExistsSync.mockReturnValue(false);
    await expect(runAgentBenchmark({
      tasksPath: '/nonexistent',
      expectedPath: '/exp',
      outputDir: '/out',
    })).rejects.toThrow();
  });
});
