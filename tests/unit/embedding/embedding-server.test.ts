import { describe, it, expect } from 'vitest';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = join(__dirname, '..', '..', '..', 'src', 'scripts', 'embedding_server.py');

describe('embedding_server.py script file', () => {
  it('script file exists', () => {
    expect(existsSync(SCRIPT_PATH)).toBe(true);
  });

  it('script is valid Python syntax', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);

    try {
      await execFileAsync('python3', ['-c', `import py_compile; py_compile.compile('${SCRIPT_PATH}', doraise=True)`], {
        timeout: 10000,
      });
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('ENOENT') || msg.includes('not found')) {
        return; // skip if no python3
      }
      throw err;
    }
  });
});
