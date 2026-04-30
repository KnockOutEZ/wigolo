import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getConfig } from './config.js';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type Module = 'fetch' | 'search' | 'crawl' | 'cache' | 'extract' | 'searxng' | 'server' | 'cli' | 'jsonld' | 'repl' | 'embedding' | 'research' | 'agent' | 'structured-data';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

let tuiLogPath: string | null = null;

function getTuiLogPath(): string {
  if (!tuiLogPath) {
    const dataDir = getConfig().dataDir;
    mkdirSync(dataDir, { recursive: true });
    tuiLogPath = join(dataDir, 'init.log');
  }
  return tuiLogPath;
}

function appendToLogFile(line: string): void {
  try {
    appendFileSync(getTuiLogPath(), line + '\n');
  } catch {
    // best effort — don't crash the TUI
  }
}

function writeJson(level: LogLevel, module: string, msg: string, data?: Record<string, unknown>): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    module,
    ...(data ? { data } : {}),
  });
  if (process.env.WIGOLO_TUI_MODE === 'true') {
    appendToLogFile(line);
    return;
  }
  process.stderr.write(line + '\n');
}

function writeText(level: LogLevel, module: string, msg: string, data?: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  const dataStr = data ? ' ' + Object.entries(data).map(([k, v]) => `${k}=${v}`).join(' ') : '';
  const line = `[${ts}] ${level.toUpperCase().padEnd(5)} [${module}] ${msg}${dataStr}`;
  if (process.env.WIGOLO_TUI_MODE === 'true') {
    appendToLogFile(line);
    return;
  }
  process.stderr.write(line + '\n');
}

export function createLogger(module: Module): Logger {
  const config = getConfig();
  const minPriority = LEVEL_PRIORITY[config.logLevel];
  const write = config.logFormat === 'json' ? writeJson : writeText;

  function log(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
    if (LEVEL_PRIORITY[level] >= minPriority) {
      write(level, module, msg, data);
    }
  }

  return {
    debug: (msg, data) => log('debug', msg, data),
    info: (msg, data) => log('info', msg, data),
    warn: (msg, data) => log('warn', msg, data),
    error: (msg, data) => log('error', msg, data),
  };
}
