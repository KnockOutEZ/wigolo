import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';
import {
  getVersion,
  printHelp,
  printVersion,
  printUnknownCommand,
  sanitizeCapabilityText,
  TOOL_HELP,
  TOOL_COMMANDS,
  isToolCommand,
} from '../../../src/cli/help.js';

function captureStream(): { stream: NodeJS.WriteStream; output: () => string } {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      cb();
    },
  }) as unknown as NodeJS.WriteStream;
  return { stream, output: () => Buffer.concat(chunks).toString('utf-8') };
}

describe('getVersion', () => {
  it('returns semver from package.json', () => {
    expect(getVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('printHelp', () => {
  it('lists usage + all known subcommands + options', () => {
    const { stream, output } = captureStream();
    printHelp(stream);
    const text = output();
    expect(text).toContain('Usage:');
    expect(text).toContain('warmup');
    expect(text).toContain('serve');
    expect(text).toContain('health');
    expect(text).toContain('doctor');
    expect(text).toContain('auth');
    expect(text).toContain('plugin');
    expect(text).toContain('shell');
    expect(text).toContain('init');
    expect(text).toContain('uninstall');
    expect(text).toContain('setup');
    expect(text).toContain('skills');
    expect(text).toContain('status');
    expect(text).toContain('--help');
    expect(text).toContain('--version');
  });

  it('lists all ten one-shot tool commands', () => {
    const { stream, output } = captureStream();
    printHelp(stream);
    const text = output();
    for (const tool of ['search', 'fetch', 'crawl', 'extract', 'cache', 'find-similar', 'research', 'agent', 'diff', 'watch']) {
      expect(text).toContain(tool);
    }
    // The snake-case alias is documented next to find-similar.
    expect(text).toContain('find_similar');
  });

  it('documents the warmup flag set in capability language', () => {
    const { stream, output } = captureStream();
    printHelp(stream);
    const text = output();
    // The global help is capability-language only (no sidecar implementation
    // name); the warmup line advertises the component groups it can re-warm.
    expect(text).toContain('warmup [--all|--browser|--reranker|--embeddings]');
    expect(text).not.toMatch(/searxng/i);
  });

  it('documents doctor --fix and --json (S9/D9)', () => {
    const { stream, output } = captureStream();
    printHelp(stream);
    const text = output();
    expect(text).toContain('doctor [--fix] [--json]');
  });

  it('documents --json on the diagnose commands (status, health, verify)', () => {
    const { stream, output } = captureStream();
    printHelp(stream);
    const text = output();
    // The diagnose commands are AI-drivable with --json.
    expect(text).toContain('status [--json]');
    expect(text).toContain('health [--json]');
    expect(text).toContain('verify [--json]');
  });
});

describe('TOOL_HELP', () => {
  it('has a --help entry for every tool command incl. the alias', () => {
    for (const cmd of TOOL_COMMANDS) {
      expect(TOOL_HELP[cmd]).toBeTruthy();
      expect(TOOL_HELP[cmd].length).toBeGreaterThan(0);
    }
  });

  it('every tool help documents the --json flag', () => {
    for (const cmd of TOOL_COMMANDS) {
      expect(TOOL_HELP[cmd]).toContain('--json');
    }
  });

  it('diff help documents the one-shot cached-vs-live behavior', () => {
    expect(TOOL_HELP.diff).toContain('cached');
    expect(TOOL_HELP.diff).toContain('--output');
    expect(TOOL_HELP.diff).toContain('--granularity');
  });

  it('watch help carries the resident-scheduler caveat', () => {
    expect(TOOL_HELP.watch).toContain('wigolo serve');
    expect(TOOL_HELP.watch).toContain('MCP session');
  });
});

describe('sanitizeCapabilityText', () => {
  it('swaps implementation names for capability language (defence in depth)', () => {
    // WHY: schema descriptions are authored to capability language, but this
    // render-time guard must catch any leaked library name. If a term is not
    // mapped, it surfaces verbatim in user-facing help — a naming-rule breach.
    const cases: Array<[string, string, string]> = [
      ['Uses Playwright to render', 'playwright', 'browser engine'],
      ['Powered by SearXNG aggregation', 'searxng', 'search engine'],
      ['Readability.js parses the DOM', 'readability', 'content extractor'],
      ['Extracted via Trafilatura', 'trafilatura', 'content extractor'],
      ['Reranked with FlashRank', 'flashrank', 'ML reranker'],
      ['Fetched over CDP', 'cdp', 'browser control protocol'],
    ];
    for (const [input, leaked, capability] of cases) {
      const out = sanitizeCapabilityText(input);
      expect(out.toLowerCase()).not.toContain(leaked);
      expect(out).toContain(capability);
    }
  });

  it('leaves capability-language descriptions untouched', () => {
    const clean = 'Fetch a page as clean markdown with structured metadata.';
    expect(sanitizeCapabilityText(clean)).toBe(clean);
  });

  it('does not maul unrelated words containing "cdp" as a substring', () => {
    // The \bcdp\b guard is word-bounded: "cdp" inside another token stays put.
    expect(sanitizeCapabilityText('run the abcdef helper')).toBe('run the abcdef helper');
  });
});

describe('isToolCommand', () => {
  it('accepts the ten tools and the find_similar alias', () => {
    for (const t of ['search', 'fetch', 'crawl', 'extract', 'cache', 'find-similar', 'find_similar', 'research', 'agent', 'diff', 'watch']) {
      expect(isToolCommand(t)).toBe(true);
    }
  });

  it('rejects non-tool commands', () => {
    for (const t of ['serve', 'doctor', 'init', 'warmup', 'nonsense']) {
      expect(isToolCommand(t)).toBe(false);
    }
  });
});

describe('printVersion', () => {
  it('writes "wigolo <semver>\\n"', () => {
    const { stream, output } = captureStream();
    printVersion(stream);
    expect(output()).toMatch(/^wigolo \d+\.\d+\.\d+(.*)?\n$/);
  });
});

describe('printUnknownCommand', () => {
  it('prefixes unknown command name then prints help', () => {
    const { stream, output } = captureStream();
    printUnknownCommand('foobar', stream);
    const text = output();
    expect(text).toContain("unknown command 'foobar'");
    expect(text).toContain('Usage:');
  });
});
