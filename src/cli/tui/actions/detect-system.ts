/**
 * detectSystem action — thin wrapper around system-check primitives.
 * Returns a structured result usable by both TUI and headless CLI.
 */
import {
  checkNode,
  checkPython,
  checkDocker,
  checkDiskSpace,
} from '../system-check.js';

export interface SystemInfo {
  nodeOk: boolean;
  nodeVersion: string;
  nodeMessage?: string;
  pythonOk: boolean;
  pythonVersion: string;
  pythonBinary?: string;
  pythonMessage?: string;
  dockerOk: boolean;
  dockerVersion?: string;
  diskOk: boolean;
  diskFreeMb?: number;
  diskMessage?: string;
  /** True when a hard-failure condition (node or python missing) is detected. */
  hardFailure: boolean;
}

export async function detectSystem(): Promise<SystemInfo> {
  const node = checkNode();
  const python = checkPython();
  const docker = checkDocker();
  const disk = await checkDiskSpace();
  const hardFailure = !node.ok || !python.ok;

  return {
    nodeOk: node.ok,
    nodeVersion: node.version ?? '',
    nodeMessage: node.message,
    pythonOk: python.ok,
    pythonVersion: python.version ?? '',
    pythonBinary: python.binary,
    pythonMessage: python.message,
    dockerOk: docker.ok,
    dockerVersion: docker.version,
    diskOk: disk.ok,
    diskFreeMb: disk.freeMb,
    diskMessage: disk.message,
    hardFailure,
  };
}
