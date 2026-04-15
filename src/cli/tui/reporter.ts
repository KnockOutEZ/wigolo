export interface WarmupReporter {
  start(id: string, label: string, opts?: { totalBytes?: number }): void;
  update(id: string, text: string): void;
  progress(id: string, fraction: number): void;
  success(id: string, detail?: string): void;
  fail(id: string, error: string): void;
  note(text: string): void;
  finish(): void;
}

export class PlainReporter implements WarmupReporter {
  private readonly prefix: string;

  constructor(command = 'warmup') {
    this.prefix = `[wigolo ${command}]`;
  }

  private write(line: string): void {
    process.stderr.write(`${this.prefix} ${line}\n`);
  }

  start(_id: string, label: string, _opts?: { totalBytes?: number }): void {
    this.write(`${label}...`);
  }

  update(_id: string, _text: string): void {
    // no-op in plain mode
  }

  progress(_id: string, _fraction: number): void {
    // no-op in plain mode
  }

  success(id: string, detail?: string): void {
    this.write(`${id} ${detail ?? 'ok'}`);
  }

  fail(id: string, error: string): void {
    this.write(`${id} failed: ${error}`);
  }

  note(text: string): void {
    this.write(text);
  }

  finish(): void {
    // no-op
  }
}
