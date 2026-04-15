import chalk from 'chalk';

const BANNER_LINES: readonly string[] = [
  '  ╦ ╦╦╔═╗╔═╗╦  ╔═╗',
  '  ║║║║║ ╦║ ║║  ║ ║',
  '  ╚╩╝╩╚═╝╚═╝╩═╝╚═╝',
];

const TAGLINE = 'Local-first web intelligence for AI agents';

export function renderBanner(version: string): string {
  const colored = BANNER_LINES.map(line => chalk.cyan(line)).join('\n');
  const tagline = chalk.gray(`  ${TAGLINE}`);
  const versionText = version ? chalk.gray(`  v${version}`) : '';

  return [colored, tagline, versionText, ''].filter(l => l !== '').join('\n') + '\n';
}
