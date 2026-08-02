// Cross-platform runner for the Python SDK suite (venv layout differs on win32).
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const py =
  process.platform === 'win32'
    ? join(root, 'sdks', 'python', '.venv', 'Scripts', 'python.exe')
    : join(root, 'sdks', 'python', '.venv', 'bin', 'python');

if (!existsSync(py)) {
  console.error(
    'Python SDK venv missing — bootstrap it first:\n' +
      '  python3 -m venv sdks/python/.venv && sdks/python/.venv/bin/pip install pytest build'
  );
  process.exit(1);
}

execFileSync(py, ['-m', 'pytest', join(root, 'sdks', 'python', 'tests')], { stdio: 'inherit' });
