import { promises as fs } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

export type WriteCode =
  | 'OK'
  | 'PERMISSION_DENIED'
  | 'PARSE_ERROR'
  | 'MKDIR_FAILED'
  | 'WRITE_FAILED';

export interface WriteJsonConfigArgs {
  path: string;
  keyPath: string[];
  entry: Record<string, unknown>;
  dryRun?: boolean;
  allowJsonc?: boolean;
  requireBackup?: boolean;
  refuseSymlink?: boolean;
}

export interface WriteJsonConfigResult {
  ok: boolean;
  code: WriteCode;
  message?: string;
  dryRun?: boolean;
  backupPath?: string;
  /** SHA-256 of the exact bytes written, used to guard transactional rollback. */
  writtenContentHash?: string;
}

export interface RemoveJsonConfigEntryArgs {
  path: string;
  keyPath: string[];
  dryRun?: boolean;
  allowJsonc?: boolean;
  requireBackup?: boolean;
  refuseSymlink?: boolean;
}

export interface RemoveJsonConfigEntryResult extends WriteJsonConfigResult {
  removed: boolean;
}

function setAtPath(obj: Record<string, unknown>, keyPath: string[], value: unknown): void {
  let cursor = obj;
  for (let i = 0; i < keyPath.length - 1; i++) {
    const k = keyPath[i];
    if (typeof cursor[k] !== 'object' || cursor[k] === null || Array.isArray(cursor[k])) {
      cursor[k] = {};
    }
    cursor = cursor[k] as Record<string, unknown>;
  }
  cursor[keyPath[keyPath.length - 1]] = value;
}

function removeAtPath(obj: Record<string, unknown>, keyPath: string[]): boolean {
  if (keyPath.length === 0) return false;
  let cursor = obj;
  for (let i = 0; i < keyPath.length - 1; i++) {
    const k = keyPath[i];
    if (typeof cursor[k] !== 'object' || cursor[k] === null || Array.isArray(cursor[k])) {
      return false;
    }
    cursor = cursor[k] as Record<string, unknown>;
  }
  const leaf = keyPath[keyPath.length - 1];
  if (!Object.prototype.hasOwnProperty.call(cursor, leaf)) return false;
  delete cursor[leaf];
  return true;
}

/** Normalize OpenCode-style JSONC without evaluating arbitrary code. */
function normalizeJsonc(text: string): string {
  const withoutComments: string[] = [];
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inString) {
      withoutComments.push(ch);
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      withoutComments.push(ch);
      continue;
    }

    if (ch === '/' && next === '/') {
      withoutComments.push(' ', ' ');
      i += 2;
      while (i < text.length && text[i] !== '\n' && text[i] !== '\r') {
        withoutComments.push(' ');
        i++;
      }
      if (i < text.length) withoutComments.push(text[i]);
      continue;
    }

    if (ch === '/' && next === '*') {
      withoutComments.push(' ', ' ');
      i += 2;
      let closed = false;
      while (i < text.length) {
        if (text[i] === '*' && text[i + 1] === '/') {
          withoutComments.push(' ', ' ');
          i++;
          closed = true;
          break;
        }
        withoutComments.push(text[i] === '\n' || text[i] === '\r' ? text[i] : ' ');
        i++;
      }
      if (!closed) throw new SyntaxError('unterminated block comment');
      continue;
    }

    withoutComments.push(ch);
  }

  const chars = withoutComments;
  inString = false;
  escaped = false;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch !== ',') continue;
    let j = i + 1;
    while (j < chars.length && /\s/.test(chars[j])) j++;
    if (chars[j] === '}' || chars[j] === ']') chars[i] = ' ';
  }
  return chars.join('');
}

export function parseJsonObject(raw: string, allowJsonc: boolean): Record<string, unknown> {
  const source = allowJsonc && raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const parsed = JSON.parse(allowJsonc ? normalizeJsonc(source) : source);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SyntaxError('existing config is not a JSON object');
  }
  return parsed as Record<string, unknown>;
}

interface JsoncPropertyNode {
  key: string;
  keyStart: number;
  value: JsoncValueNode;
  commaStart?: number;
  commaEnd?: number;
}

interface JsoncObjectNode {
  type: 'object';
  start: number;
  end: number;
  properties: JsoncPropertyNode[];
}

interface JsoncScalarNode {
  type: 'scalar' | 'array';
  start: number;
  end: number;
}

type JsoncValueNode = JsoncObjectNode | JsoncScalarNode;

/** Position-only JSONC parser used to edit one owned property without reformatting the file. */
class JsoncSourceParser {
  private pos = 0;

  constructor(private readonly text: string) {}

  parseRootObject(): JsoncObjectNode {
    if (this.text.charCodeAt(0) === 0xfeff) this.pos = 1;
    this.skipTrivia();
    const root = this.parseValue();
    this.skipTrivia();
    if (root.type !== 'object' || this.pos !== this.text.length) {
      throw new SyntaxError('existing config is not a JSON object');
    }
    return root;
  }

  private parseValue(): JsoncValueNode {
    this.skipTrivia();
    const start = this.pos;
    const ch = this.text[this.pos];
    if (ch === '{') return this.parseObject();
    if (ch === '[') return this.parseArray();
    if (ch === '"') {
      this.parseString();
      return { type: 'scalar', start, end: this.pos };
    }
    while (this.pos < this.text.length) {
      const current = this.text[this.pos];
      const next = this.text[this.pos + 1];
      if (/\s|,|\]|}/.test(current)) break;
      if (current === '/' && (next === '/' || next === '*')) break;
      this.pos++;
    }
    if (this.pos === start) throw new SyntaxError(`expected JSON value at offset ${start}`);
    return { type: 'scalar', start, end: this.pos };
  }

  private parseObject(): JsoncObjectNode {
    const start = this.pos++;
    const properties: JsoncPropertyNode[] = [];
    while (true) {
      this.skipTrivia();
      if (this.text[this.pos] === '}') {
        this.pos++;
        return { type: 'object', start, end: this.pos, properties };
      }

      const keyStart = this.pos;
      const key = this.parseString();
      this.skipTrivia();
      this.expect(':');
      this.pos++;
      const value = this.parseValue();
      this.skipTrivia();

      let commaStart: number | undefined;
      let commaEnd: number | undefined;
      if (this.text[this.pos] === ',') {
        commaStart = this.pos;
        commaEnd = ++this.pos;
      }
      properties.push({ key, keyStart, value, commaStart, commaEnd });

      this.skipTrivia();
      if (this.text[this.pos] === '}') {
        this.pos++;
        return { type: 'object', start, end: this.pos, properties };
      }
      if (commaStart === undefined) {
        throw new SyntaxError(`expected ',' or '}' at offset ${this.pos}`);
      }
    }
  }

  private parseArray(): JsoncScalarNode {
    const start = this.pos++;
    while (true) {
      this.skipTrivia();
      if (this.text[this.pos] === ']') {
        this.pos++;
        return { type: 'array', start, end: this.pos };
      }
      this.parseValue();
      this.skipTrivia();
      if (this.text[this.pos] === ',') {
        this.pos++;
        continue;
      }
      if (this.text[this.pos] !== ']') {
        throw new SyntaxError(`expected ',' or ']' at offset ${this.pos}`);
      }
    }
  }

  private parseString(): string {
    const start = this.pos;
    this.expect('"');
    this.pos++;
    let escaped = false;
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos++];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') return JSON.parse(this.text.slice(start, this.pos)) as string;
    }
    throw new SyntaxError(`unterminated string at offset ${start}`);
  }

  private skipTrivia(): void {
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos];
      const next = this.text[this.pos + 1];
      if (/\s/.test(ch)) {
        this.pos++;
        continue;
      }
      if (ch === '/' && next === '/') {
        this.pos += 2;
        while (this.pos < this.text.length && !/[\r\n]/.test(this.text[this.pos])) this.pos++;
        continue;
      }
      if (ch === '/' && next === '*') {
        const end = this.text.indexOf('*/', this.pos + 2);
        if (end === -1) throw new SyntaxError('unterminated block comment');
        this.pos = end + 2;
        continue;
      }
      return;
    }
  }

  private expect(expected: string): void {
    if (this.text[this.pos] !== expected) {
      throw new SyntaxError(`expected '${expected}' at offset ${this.pos}`);
    }
  }
}

function propertyForKey(node: JsoncObjectNode, key: string): JsoncPropertyNode | undefined {
  const matches = node.properties.filter((property) => property.key === key);
  if (matches.length > 1) {
    throw new SyntaxError(`duplicate property '${key}' in owned JSONC path`);
  }
  return matches[0];
}

function lineIndentAt(text: string, position: number): string {
  const lineStart = text.lastIndexOf('\n', position - 1) + 1;
  const prefix = text.slice(lineStart, position);
  return /^[\t ]*$/.test(prefix) ? prefix : '';
}

function formatJsonValue(value: unknown, indent: string): string {
  return JSON.stringify(value, null, 2).replace(/\n/g, `\n${indent}`);
}

function nestedValue(keyPath: string[], from: number, value: unknown): unknown {
  let nested = value;
  for (let i = keyPath.length - 1; i >= from; i--) nested = { [keyPath[i]]: nested };
  return nested;
}

function insertJsoncProperty(
  source: string,
  node: JsoncObjectNode,
  key: string,
  value: unknown,
): string {
  const first = node.properties[0];
  if (first) {
    const indent = lineIndentAt(source, first.keyStart);
    const multiline = source.slice(node.start + 1, first.keyStart).includes('\n');
    const prefix = multiline ? `\n${indent}` : '';
    const suffix = multiline ? '' : ' ';
    const property = `${prefix}${JSON.stringify(key)}: ${formatJsonValue(value, indent)},${suffix}`;
    return source.slice(0, node.start + 1) + property + source.slice(node.start + 1);
  }

  const closeStart = node.end - 1;
  const baseIndent = lineIndentAt(source, closeStart);
  const childIndent = `${baseIndent}  `;
  const property = `${JSON.stringify(key)}: ${formatJsonValue(value, childIndent)}`;
  const insertion = `\n${childIndent}${property}\n${baseIndent}`;
  return source.slice(0, closeStart) + insertion + source.slice(closeStart);
}

function setJsoncAtPath(source: string, keyPath: string[], value: unknown): string {
  if (keyPath.length === 0) throw new SyntaxError('keyPath must not be empty');
  const root = new JsoncSourceParser(source).parseRootObject();
  let node = root;

  for (let i = 0; i < keyPath.length; i++) {
    const property = propertyForKey(node, keyPath[i]);
    if (!property) {
      const updated = insertJsoncProperty(source, node, keyPath[i], nestedValue(keyPath, i + 1, value));
      parseJsonObject(updated, true);
      return updated;
    }

    if (i === keyPath.length - 1) {
      const indent = lineIndentAt(source, property.keyStart);
      const updated = source.slice(0, property.value.start)
        + formatJsonValue(value, indent)
        + source.slice(property.value.end);
      parseJsonObject(updated, true);
      return updated;
    }

    if (property.value.type !== 'object') {
      const indent = lineIndentAt(source, property.keyStart);
      const replacement = nestedValue(keyPath, i + 1, value);
      const updated = source.slice(0, property.value.start)
        + formatJsonValue(replacement, indent)
        + source.slice(property.value.end);
      parseJsonObject(updated, true);
      return updated;
    }
    node = property.value;
  }

  throw new SyntaxError('unable to set JSONC key path');
}

function removeJsoncAtPath(source: string, keyPath: string[]): string {
  if (keyPath.length === 0) return source;
  const root = new JsoncSourceParser(source).parseRootObject();
  let node = root;

  for (let i = 0; i < keyPath.length - 1; i++) {
    const property = propertyForKey(node, keyPath[i]);
    if (!property || property.value.type !== 'object') return source;
    node = property.value;
  }

  const property = propertyForKey(node, keyPath[keyPath.length - 1]);
  if (!property) return source;
  const edits: Array<{ start: number; end: number }> = [];
  if (property.commaEnd !== undefined) {
    edits.push({ start: property.keyStart, end: property.commaEnd });
  } else {
    const index = node.properties.indexOf(property);
    const previous = index > 0 ? node.properties[index - 1] : undefined;
    if (previous?.commaStart !== undefined && previous.commaEnd !== undefined) {
      edits.push({ start: previous.commaStart, end: previous.commaEnd });
    }
    edits.push({ start: property.keyStart, end: property.value.end });
  }

  let updated = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    updated = updated.slice(0, edit.start) + updated.slice(edit.end);
  }
  parseJsonObject(updated, true);
  return updated;
}

function isPermissionError(err: unknown): boolean {
  const code = typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code?: unknown }).code)
    : '';
  const message = err instanceof Error ? err.message : String(err);
  return code === 'EACCES' || code === 'EPERM' || /EACCES|EPERM/.test(message);
}

interface TargetState {
  exists: boolean;
  isSymbolicLink: boolean;
}

async function inspectTarget(path: string): Promise<TargetState> {
  try {
    const stat = await fs.lstat(path);
    return { exists: true, isSymbolicLink: stat.isSymbolicLink() };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { exists: false, isSymbolicLink: false };
    }
    throw err;
  }
}

function symbolicLinkResult(path: string): WriteJsonConfigResult {
  return { ok: false, code: 'WRITE_FAILED', message: `refused symbolic link config: ${path}` };
}

async function writeJsonFile(
  path: string,
  json: string,
  exists: boolean,
  requireBackup: boolean,
  refuseSymlink: boolean,
): Promise<WriteJsonConfigResult> {
  try {
    await fs.mkdir(dirname(path), { recursive: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isPermissionError(err)) {
      return { ok: false, code: 'PERMISSION_DENIED', message };
    }
    return { ok: false, code: 'MKDIR_FAILED', message };
  }

  try {
    const current = await inspectTarget(path);
    if (refuseSymlink && current.isSymbolicLink) return symbolicLinkResult(path);
    if (current.exists !== exists) {
      return { ok: false, code: 'WRITE_FAILED', message: `config target changed while writing: ${path}` };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = isPermissionError(err) ? 'PERMISSION_DENIED' : 'WRITE_FAILED';
    return { ok: false, code, message: `unable to inspect config target: ${message}` };
  }

  let existingMode: number | undefined;
  if (exists) {
    try {
      existingMode = (await fs.stat(path)).mode & 0o777;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, code: 'WRITE_FAILED', message: `unable to inspect existing config: ${message}` };
    }
  }

  let backupPath: string | undefined;
  if (exists) {
    backupPath = `${path}.bak`;
    try {
      const backup = await inspectTarget(backupPath);
      if (refuseSymlink && backup.isSymbolicLink) {
        throw new Error(`refused symbolic link backup: ${backupPath}`);
      }
      await fs.copyFile(path, backupPath);
    } catch (err) {
      backupPath = undefined;
      if (requireBackup) {
        const message = err instanceof Error ? err.message : String(err);
        const code = isPermissionError(err) ? 'PERMISSION_DENIED' : 'WRITE_FAILED';
        return { ok: false, code, message: `unable to back up existing config: ${message}` };
      }
    }
  }

  const tmpPath = join(
    dirname(path),
    `.${basename(path)}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`,
  );
  try {
    await fs.writeFile(tmpPath, json, { encoding: 'utf-8', mode: existingMode ?? 0o600 });
    if (existingMode !== undefined) {
      await fs.chmod(tmpPath, existingMode);
    }
    const current = await inspectTarget(path);
    if (refuseSymlink && current.isSymbolicLink) {
      throw new Error(`refused symbolic link config: ${path}`);
    }
    if (current.exists !== exists) throw new Error(`config target changed while writing: ${path}`);
    await fs.rename(tmpPath, path);
    return {
      ok: true,
      code: 'OK',
      backupPath,
      writtenContentHash: createHash('sha256').update(json).digest('hex'),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try { await fs.unlink(tmpPath); } catch {}
    if (isPermissionError(err)) {
      return { ok: false, code: 'PERMISSION_DENIED', message };
    }
    return { ok: false, code: 'WRITE_FAILED', message };
  }
}

export async function writeJsonConfig(args: WriteJsonConfigArgs): Promise<WriteJsonConfigResult> {
  const {
    path,
    keyPath,
    entry,
    dryRun,
    allowJsonc = false,
    requireBackup = false,
    refuseSymlink = false,
  } = args;

  let existing: Record<string, unknown> = {};
  let source: string | undefined;
  let target: TargetState;
  try {
    target = await inspectTarget(path);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = isPermissionError(err) ? 'PERMISSION_DENIED' : 'WRITE_FAILED';
    return { ok: false, code, message: `unable to inspect config target: ${message}` };
  }
  if (refuseSymlink && target.isSymbolicLink) return symbolicLinkResult(path);
  const exists = target.exists;
  if (exists) {
    try {
      const raw = await fs.readFile(path, 'utf-8');
      source = raw;
      const trimmed = raw.trim();
      if (trimmed.length > 0) {
        existing = parseJsonObject(trimmed, allowJsonc);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = isPermissionError(err) ? 'PERMISSION_DENIED' : 'PARSE_ERROR';
      const action = code === 'PERMISSION_DENIED' ? 'read' : 'parse';
      return { ok: false, code, message: `unable to ${action} existing JSON: ${message}` };
    }
  }

  setAtPath(existing, keyPath, entry);
  let json: string;
  try {
    json = allowJsonc && source?.trim()
      ? setJsoncAtPath(source, keyPath, entry)
      : JSON.stringify(existing, null, 2) + '\n';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, code: 'PARSE_ERROR', message: `unable to edit existing JSONC: ${message}` };
  }

  if (dryRun) {
    return { ok: true, code: 'OK', dryRun: true };
  }

  return writeJsonFile(path, json, exists, requireBackup, refuseSymlink);
}

export async function removeJsonConfigEntry(
  args: RemoveJsonConfigEntryArgs,
): Promise<RemoveJsonConfigEntryResult> {
  const {
    path,
    keyPath,
    dryRun,
    allowJsonc = false,
    requireBackup = false,
    refuseSymlink = false,
  } = args;
  let target: TargetState;
  try {
    target = await inspectTarget(path);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = isPermissionError(err) ? 'PERMISSION_DENIED' : 'WRITE_FAILED';
    return { ok: false, code, message: `unable to inspect config target: ${message}`, removed: false };
  }
  if (refuseSymlink && target.isSymbolicLink) {
    return { ...symbolicLinkResult(path), removed: false };
  }
  const exists = target.exists;
  if (!exists) return { ok: true, code: 'OK', removed: false, ...(dryRun ? { dryRun: true } : {}) };

  let existing: Record<string, unknown>;
  let source: string;
  try {
    source = await fs.readFile(path, 'utf-8');
    const trimmed = source.trim();
    existing = trimmed.length > 0 ? parseJsonObject(trimmed, allowJsonc) : {};
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = isPermissionError(err) ? 'PERMISSION_DENIED' : 'PARSE_ERROR';
    const action = code === 'PERMISSION_DENIED' ? 'read' : 'parse';
    return { ok: false, code, message: `unable to ${action} existing JSON: ${message}`, removed: false };
  }

  const removed = removeAtPath(existing, keyPath);
  if (!removed) return { ok: true, code: 'OK', removed: false, ...(dryRun ? { dryRun: true } : {}) };

  let json: string;
  try {
    json = allowJsonc ? removeJsoncAtPath(source, keyPath) : JSON.stringify(existing, null, 2) + '\n';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, code: 'PARSE_ERROR', message: `unable to edit existing JSONC: ${message}`, removed: false };
  }
  if (dryRun) return { ok: true, code: 'OK', removed: true, dryRun: true };

  const written = await writeJsonFile(path, json, true, requireBackup, refuseSymlink);
  return { ...written, removed: written.ok };
}
