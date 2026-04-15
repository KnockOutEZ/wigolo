import ora, { type Ora } from 'ora';
import cliProgress from 'cli-progress';
import chalk from 'chalk';
import type { WarmupReporter } from './reporter.js';

interface SpinnerState {
  spinner: Ora;
  label: string;
  bar?: cliProgress.SingleBar;
  totalBytes?: number;
}

export interface TuiReporterOptions {
  useStdout?: boolean;
}

export class TuiReporter implements WarmupReporter {
  private readonly states = new Map<string, SpinnerState>();
  private readonly stream: NodeJS.WriteStream;

  constructor(opts: TuiReporterOptions = {}) {
    this.stream = opts.useStdout === false ? process.stderr : process.stdout;
  }

  start(id: string, label: string, opts?: { totalBytes?: number }): void {
    const spinner = ora({ text: label, stream: this.stream }).start();
    this.states.set(id, { spinner, label, totalBytes: opts?.totalBytes });
  }

  update(id: string, text: string): void {
    const s = this.states.get(id);
    if (!s) return;
    s.spinner.text = text;
  }

  progress(id: string, fraction: number): void {
    const s = this.states.get(id);
    if (!s) return;
    const clamped = Math.max(0, Math.min(1, fraction));
    if (s.totalBytes && s.totalBytes > 0) {
      if (!s.bar) {
        s.spinner.stop();
        s.bar = new cliProgress.SingleBar(
          {
            format: `  ${chalk.cyan('{bar}')} {percentage}% | ${s.label}`,
            barCompleteChar: '█',
            barIncompleteChar: '░',
            hideCursor: true,
            stream: this.stream,
          },
          cliProgress.Presets.shades_classic,
        );
        s.bar.start(s.totalBytes, 0);
      }
      s.bar.update(Math.round(clamped * s.totalBytes));
    } else {
      const pct = Math.round(clamped * 100);
      s.spinner.text = `${s.label} (${pct}%)`;
    }
  }

  success(id: string, detail?: string): void {
    const s = this.states.get(id);
    if (!s) return;
    const msg = detail ? `${s.label} — ${chalk.gray(detail)}` : s.label;
    if (s.bar) {
      s.bar.update(s.totalBytes ?? 0);
      s.bar.stop();
      this.stream.write(`${chalk.green('✓')} ${msg}\n`);
    } else {
      s.spinner.succeed(msg);
    }
    this.states.delete(id);
  }

  fail(id: string, error: string): void {
    const s = this.states.get(id);
    if (!s) return;
    const msg = `${s.label} — ${chalk.red(error)}`;
    if (s.bar) {
      s.bar.stop();
      this.stream.write(`${chalk.red('✗')} ${msg}\n`);
    } else {
      s.spinner.fail(msg);
    }
    this.states.delete(id);
  }

  note(text: string): void {
    process.stdout.write(`${text}\n`);
  }

  finish(): void {
    for (const s of this.states.values()) {
      if (s.bar) { try { s.bar.stop(); } catch {} }
      else { try { s.spinner.stop(); } catch {} }
    }
    this.states.clear();
  }
}
