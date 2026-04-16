import { useState, useEffect } from 'react';
import {
  checkNode,
  checkPython,
  checkDocker,
  checkDiskSpace,
  type CheckResult,
  type PythonCheckResult,
  type DiskCheckResult,
} from '../system-check.js';

export interface CheckItem {
  id: string;
  label: string;
  status: 'pending' | 'checking' | 'pass' | 'fail' | 'optional';
  detail: string;
}

export interface SystemCheckState {
  checks: CheckItem[];
  done: boolean;
  hardFailure: boolean;
}

function nodeItem(r: CheckResult): CheckItem {
  return {
    id: 'node',
    label: 'Node.js',
    status: r.ok ? 'pass' : 'fail',
    detail: r.ok ? r.version ?? '' : r.message ?? 'not found',
  };
}

function pythonItem(r: PythonCheckResult): CheckItem {
  if (r.ok) {
    const suffix = r.binary ? ` (${r.binary})` : '';
    return { id: 'python', label: 'Python', status: 'pass', detail: `${r.version}${suffix}` };
  }
  return {
    id: 'python',
    label: 'Python',
    status: 'fail',
    detail: r.message ?? 'not found',
  };
}

function dockerItem(r: CheckResult): CheckItem {
  if (r.ok) {
    return { id: 'docker', label: 'Docker', status: 'optional', detail: `${r.version ?? ''} (optional)` };
  }
  return { id: 'docker', label: 'Docker', status: 'optional', detail: 'not found (optional)' };
}

function diskItem(r: DiskCheckResult): CheckItem {
  if (r.ok) {
    return { id: 'disk', label: 'Disk space', status: 'pass', detail: `${r.freeMb} MB free` };
  }
  return { id: 'disk', label: 'Disk space', status: 'fail', detail: r.message ?? 'low free space' };
}

const INITIAL_CHECKS: CheckItem[] = [
  { id: 'node', label: 'Node.js', status: 'pending', detail: '' },
  { id: 'python', label: 'Python', status: 'pending', detail: '' },
  { id: 'docker', label: 'Docker', status: 'pending', detail: '' },
  { id: 'disk', label: 'Disk space', status: 'pending', detail: '' },
];

const REVEAL_DELAY = 100;

export function useSystemCheck(): SystemCheckState {
  const [checks, setChecks] = useState<CheckItem[]>(INITIAL_CHECKS);
  const [done, setDone] = useState(false);
  const [hardFailure, setHardFailure] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      // Node check
      if (cancelled) return;
      setChecks((prev) => prev.map((c) => (c.id === 'node' ? { ...c, status: 'checking' } : c)));
      await new Promise((r) => setTimeout(r, REVEAL_DELAY));
      const nodeResult = checkNode();
      if (cancelled) return;
      setChecks((prev) => prev.map((c) => (c.id === 'node' ? nodeItem(nodeResult) : c)));

      // Python check
      await new Promise((r) => setTimeout(r, REVEAL_DELAY));
      if (cancelled) return;
      setChecks((prev) => prev.map((c) => (c.id === 'python' ? { ...c, status: 'checking' } : c)));
      await new Promise((r) => setTimeout(r, REVEAL_DELAY));
      const pythonResult = checkPython();
      if (cancelled) return;
      setChecks((prev) => prev.map((c) => (c.id === 'python' ? pythonItem(pythonResult) : c)));

      // Docker check
      await new Promise((r) => setTimeout(r, REVEAL_DELAY));
      if (cancelled) return;
      setChecks((prev) => prev.map((c) => (c.id === 'docker' ? { ...c, status: 'checking' } : c)));
      await new Promise((r) => setTimeout(r, REVEAL_DELAY));
      const dockerResult = checkDocker();
      if (cancelled) return;
      setChecks((prev) => prev.map((c) => (c.id === 'docker' ? dockerItem(dockerResult) : c)));

      // Disk check
      await new Promise((r) => setTimeout(r, REVEAL_DELAY));
      if (cancelled) return;
      setChecks((prev) => prev.map((c) => (c.id === 'disk' ? { ...c, status: 'checking' } : c)));
      await new Promise((r) => setTimeout(r, REVEAL_DELAY));
      const diskResult = await checkDiskSpace();
      if (cancelled) return;
      setChecks((prev) => prev.map((c) => (c.id === 'disk' ? diskItem(diskResult) : c)));

      const hard = !nodeResult.ok || !pythonResult.ok;
      setHardFailure(hard);
      setDone(true);
    }

    run();
    return () => { cancelled = true; };
  }, []);

  return { checks, done, hardFailure };
}
