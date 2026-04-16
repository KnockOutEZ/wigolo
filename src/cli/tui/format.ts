import chalk from 'chalk';

export const SYMBOLS = {
  ok: '✓',
  fail: '✗',
  warn: '⚠',
  info: 'ℹ',
  skip: '⊘',
} as const;

export function ok(text: string): string {
  return `${chalk.green(SYMBOLS.ok)} ${text}`;
}

export function fail(text: string): string {
  return `${chalk.red(SYMBOLS.fail)} ${text}`;
}

export function warn(text: string): string {
  return `${chalk.yellow(SYMBOLS.warn)} ${text}`;
}

export function info(text: string): string {
  return `${chalk.blue(SYMBOLS.info)} ${text}`;
}

export function skip(text: string): string {
  return `${chalk.gray(SYMBOLS.skip)} ${chalk.gray(text)}`;
}

const ANSI_RE = /\u001b\[[0-9;]*[A-Za-z]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}
