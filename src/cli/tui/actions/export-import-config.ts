/**
 * exportConfig / importConfig actions — serialize/deserialize persisted
 * settings to/from a portable file.
 *
 * Export contract:
 *   - Contains: version, settings (curated — secrets stripped), provider
 *     (name + keyLocation ONLY — never key values), exportedAt timestamp.
 *   - Secrets guard: SETTINGS_SECRETS_DENYLIST is applied on export AND import
 *     so a hand-crafted export file cannot smuggle secrets into config.json.
 *
 * Import contract:
 *   - Validates the file is parseable JSON with at minimum a settings field.
 *   - Applies via SP0's writePersistedConfig (merge-patch, secrets stripped).
 *   - Returns ok=false + error on any parse/validation failure.
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  readPersistedConfig,
  writePersistedConfig,
  SETTINGS_SECRETS_DENYLIST,
} from '../../../persisted-config.js';

/**
 * Upper bound on an import file's size; a larger file is treated as corrupt and
 * rejected rather than parsed (cheap DoS / accidental-blob guard). Mirrors
 * persisted-config.ts's MAX_CONFIG_BYTES.
 */
const MAX_IMPORT_BYTES = 1_000_000;

export interface ExportConfigResult {
  ok: boolean;
  /** Path written to */
  path?: string;
  error?: string;
}

export interface ImportConfigResult {
  ok: boolean;
  error?: string;
}

/** Shape of the export file. */
interface ExportEnvelope {
  version: number;
  exportedAt: string;
  settings: Record<string, unknown>;
  provider?: { name: string; keyLocation: string };
}

/** Strip secret keys from a settings map before export or import. */
function stripSecrets(settings: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(settings)) {
    if (SETTINGS_SECRETS_DENYLIST.has(k)) continue;
    // Additional guard: skip any key that looks like a secret
    const lower = k.toLowerCase();
    if (lower.includes('apikey') || lower.includes('token') || lower.includes('secret')) {
      continue;
    }
    out[k] = v;
  }
  return out;
}

export async function exportConfig(
  exportPath: string,
  configPath: string,
): Promise<ExportConfigResult> {
  try {
    const cfg = readPersistedConfig(configPath);

    const settings = stripSecrets(
      typeof cfg.settings === 'object' && cfg.settings !== null
        ? (cfg.settings as Record<string, unknown>)
        : {},
    );

    const envelope: ExportEnvelope = {
      version: cfg.version,
      exportedAt: new Date().toISOString(),
      settings,
    };

    // Include provider metadata (name + keyLocation only, never the key value)
    if (cfg.provider) {
      envelope.provider = {
        name: cfg.provider.name,
        keyLocation: cfg.provider.keyLocation,
      };
    }

    // Atomic write (temp + rename) with owner-only permissions. On any write
    // or rename failure, remove the temp file so a (non-secret) envelope is not
    // left orphaned on disk.
    const dir = dirname(exportPath);
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.export-${randomBytes(6).toString('hex')}.tmp`);
    try {
      writeFileSync(tmp, JSON.stringify(envelope, null, 2), { mode: 0o600 });
      renameSync(tmp, exportPath);
    } catch (writeErr) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        // best-effort cleanup
      }
      throw writeErr;
    }

    return { ok: true, path: exportPath };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function importConfig(
  importPath: string,
  configPath: string,
): Promise<ImportConfigResult> {
  try {
    if (!existsSync(importPath)) {
      return { ok: false, error: `Import file not found: ${importPath}` };
    }

    // Size-cap before reading the whole file into memory.
    try {
      if (statSync(importPath).size > MAX_IMPORT_BYTES) {
        return {
          ok: false,
          error: `Import file exceeds ${MAX_IMPORT_BYTES} bytes; refusing to read`,
        };
      }
    } catch (statErr) {
      return {
        ok: false,
        error: statErr instanceof Error ? statErr.message : String(statErr),
      };
    }

    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(importPath, 'utf-8'));
    } catch {
      return { ok: false, error: 'Import file is not valid JSON' };
    }

    if (typeof raw !== 'object' || raw === null) {
      return { ok: false, error: 'Import file is not a valid config envelope' };
    }

    const envelope = raw as Record<string, unknown>;
    if (typeof envelope.settings !== 'object' || envelope.settings === null) {
      return { ok: false, error: 'Import file missing settings field' };
    }

    // Strip secrets from imported settings (second line of defense)
    const cleanSettings = stripSecrets(envelope.settings as Record<string, unknown>);

    writePersistedConfig(configPath, { settings: cleanSettings });

    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
