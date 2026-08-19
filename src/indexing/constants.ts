export const MAX_INDEX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_INDEX_FILES = 10_000;

export const SKIP_DIR_NAMES = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  '__pycache__',
  '.tox',
  '.venv',
  'venv',
]);

export const SKIP_BASENAMES = new Set([
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
  '.env.test',
]);

export const SKIP_EXTENSIONS = new Set([
  '.pem',
  '.key',
  '.p12',
  '.pfx',
  '.crt',
  '.cer',
  '.der',
]);

export const DEFAULT_ALLOWED_EXTENSIONS = new Set(['.md', '.txt', '.markdown']);
