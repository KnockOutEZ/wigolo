import { readFileSync, writeFileSync } from 'node:fs';

/**
 * Build a REAL `.asar` desktop-app archive on disk.
 *
 * Why this exists rather than a fixture directory named `app.asar`: the whole
 * defect being guarded is that an archive is a single FILE, so a path that
 * points "inside" it resolves to nothing at the OS level. A directory with the
 * same name reproduces the string but not the failure, and every earlier test
 * of this loader ran from a loose directory — which is exactly why the archive
 * case shipped broken. The bytes have to be a real archive for the ENOTDIR to
 * be real.
 *
 * Format, per @electron/asar's `disk.writeFilesystem`:
 *   pickle(UInt32 headerLength) ++ pickle(String headerJSON) ++ file bytes
 * where a pickle is `UInt32LE payloadLength ++ payload`, payload padded to a
 * 4-byte boundary, and a String payload is `UInt32LE byteLength ++ bytes ++ pad`.
 * Offsets in the header are byte offsets into the concatenated file section and
 * are encoded as strings.
 *
 * Written by hand rather than via `@electron/asar` so the suite gains no
 * dependency for one helper. That trade is only safe because the archive is
 * validated from the OUTSIDE — `apps/studio` reads a marker back out of one of
 * these through the desktop shell's own patched `fs`, so a malformed writer
 * cannot masquerade as a passing test.
 */
const align4 = (n: number): number => n + ((4 - (n % 4)) % 4);

function pickleUInt32(value: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeUInt32LE(4, 0);
  buf.writeUInt32LE(value, 4);
  return buf;
}

function pickleString(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8');
  const payloadLength = 4 + align4(bytes.length);
  const buf = Buffer.alloc(4 + payloadLength);
  buf.writeUInt32LE(payloadLength, 0);
  buf.writeUInt32LE(bytes.length, 4);
  bytes.copy(buf, 8);
  return buf;
}

export interface ArchiveEntry {
  /** File name inside the archive (flat — no nested dirs needed here). */
  name: string;
  /** Copy the bytes of this on-disk file into the archive. */
  sourcePath?: string;
  /** …or supply the contents directly. */
  content?: string;
}

/** Write a flat archive containing `entries` to `outPath`. */
export function writeAppArchive(outPath: string, entries: ArchiveEntry[]): void {
  const files: Record<string, { size: number; offset: string }> = {};
  const blobs: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const buf =
      entry.content !== undefined
        ? Buffer.from(entry.content, 'utf8')
        : readFileSync(entry.sourcePath!);
    files[entry.name] = { size: buf.length, offset: String(offset) };
    offset += buf.length;
    blobs.push(buf);
  }

  const header = pickleString(JSON.stringify({ files }));
  writeFileSync(outPath, Buffer.concat([pickleUInt32(header.length), header, ...blobs]));
}
