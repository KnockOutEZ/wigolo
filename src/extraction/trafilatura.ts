// src/extraction/trafilatura.ts
import { spawn, execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { ExtractionResult } from '../types.js';
import { createLogger } from '../logger.js';

const execFileAsync = promisify(execFileCb);
const log = createLogger('extract');

const MIN_CONTENT_THRESHOLD = 100;
const SUBPROCESS_TIMEOUT_MS = 15000;
const AVAILABILITY_CHECK_TIMEOUT_MS = 5000;

const TRAFILATURA_SCRIPT = `
import sys, json
from trafilatura import extract
html = sys.stdin.read()
result = extract(html, output_format='json', include_links=True, include_images=True, favor_precision=True)
print(result or '{}')
`.trim();

let availableCache: boolean | null = null;

export async function isTrafilaturaAvailable(): Promise<boolean> {
  if (availableCache !== null) return availableCache;
  try {
    await execFileAsync('python3', ['-c', 'import trafilatura'], {
      timeout: AVAILABILITY_CHECK_TIMEOUT_MS,
    });
    availableCache = true;
  } catch {
    availableCache = false;
  }
  return availableCache;
}

export function resetAvailabilityCache(): void {
  availableCache = null;
}

export function runPythonWithStdin(
  script: string,
  stdin: string,
  timeoutMs: number,
): Promise<string> {
  const procRef = { current: null as ReturnType<typeof spawn> | null };

  const procPromise = new Promise<string>((resolve, reject) => {
    const proc = spawn('python3', ['-c', script], { timeout: timeoutMs });
    procRef.current = proc;
    let stdout = '';
    let stderr = '';

    proc.stdout!.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    proc.stderr!.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on('close', (code, signal) => {
      if (signal) {
        reject(new Error(`Python killed by signal ${signal}: ${stderr}`));
      } else if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`Python exited ${code}: ${stderr}`));
      }
    });
    proc.on('error', reject);

    proc.stdin!.write(stdin);
    proc.stdin!.end();
  });

  const timeoutPromise = new Promise<string>((_, reject) =>
    setTimeout(() => {
      procRef.current?.kill();
      reject(new Error(`Python timed out after ${timeoutMs}ms`));
    }, timeoutMs),
  );

  return Promise.race([procPromise, timeoutPromise]);
}

export async function trafilaturaExtract(
  html: string,
  url: string,
): Promise<ExtractionResult | null> {
  try {
    const stdout = await runPythonWithStdin(
      TRAFILATURA_SCRIPT,
      html,
      SUBPROCESS_TIMEOUT_MS,
    );

    const trimmed = stdout.trim();
    if (!trimmed || trimmed === 'null') return null;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      log.debug('Trafilatura output was not valid JSON', { url });
      return null;
    }

    if (!parsed || typeof parsed !== 'object') return null;

    const text = typeof parsed.text === 'string' ? parsed.text : '';
    if (text.length < MIN_CONTENT_THRESHOLD) return null;

    return {
      title: typeof parsed.title === 'string' ? parsed.title : '',
      markdown: text,
      metadata: {
        author: typeof parsed.author === 'string' ? parsed.author : undefined,
        date: typeof parsed.date === 'string' ? parsed.date : undefined,
      },
      links: [],
      images: [],
      extractor: 'trafilatura',
    };
  } catch (err) {
    log.debug('Trafilatura extraction failed', { url, error: String(err) });
    return null;
  }
}
