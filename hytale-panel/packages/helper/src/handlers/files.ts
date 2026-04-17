import * as fs from 'fs/promises';
import * as crypto from 'crypto';
import { guardPath, isRegularFile } from '../utils/path-guard';
import { BanFileSchema } from '@hytale-panel/shared';
import type { BanEntry } from '@hytale-panel/shared';
import type { HelperConfig } from '../config';

const MAX_CONFIG_FILE_BYTES = 10 * 1024 * 1024;

async function assertFileWithinSizeLimit(safePath: string, label: string): Promise<string | null> {
  const stat = await fs.stat(safePath);
  if (stat.size > MAX_CONFIG_FILE_BYTES) {
    return `${label} file exceeds the ${MAX_CONFIG_FILE_BYTES} byte limit (actual: ${stat.size})`;
  }
  return null;
}

// Write then rename — crash-safe replacement. The unique suffix avoids
// clobbering between overlapping writers; the rename is atomic on POSIX
// within a single filesystem (tmp lives in the same dir as the target).
async function atomicWriteFile(targetPath: string, content: string): Promise<void> {
  const tmpPath = `${targetPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.writeFile(tmpPath, content, 'utf-8');
    await fs.rename(tmpPath, targetPath);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }
}

/**
 * Hytale whitelist.json format:
 * { "enabled": true, "list": ["uuid-or-name-1", "uuid-or-name-2"] }
 */
interface WhitelistData {
  enabled: boolean;
  list: string[];
}

/**
 * Read and parse the whitelist file (Hytale format).
 */
export async function readWhitelist(
  config: HelperConfig
): Promise<{ success: boolean; enabled: boolean; list: string[]; error?: string }> {
  try {
    const safePath = await guardPath(config.whitelistPath, config.hytaleRoot);

    try {
      await fs.access(safePath);
    } catch {
      return { success: true, enabled: false, list: [] };
    }

    if (!(await isRegularFile(safePath))) {
      return { success: false, enabled: false, list: [], error: 'Whitelist path is not a regular file' };
    }

    const sizeError = await assertFileWithinSizeLimit(safePath, 'Whitelist');
    if (sizeError) {
      return { success: false, enabled: false, list: [], error: sizeError };
    }

    const raw = await fs.readFile(safePath, 'utf-8');
    const parsed = JSON.parse(raw) as WhitelistData;

    return {
      success: true,
      enabled: parsed.enabled ?? false,
      list: Array.isArray(parsed.list) ? parsed.list : [],
    };
  } catch (err) {
    return { success: false, enabled: false, list: [], error: `Failed to read whitelist: ${String(err).slice(0, 200)}` };
  }
}

/**
 * Write the whitelist file in Hytale format.
 */
export async function writeWhitelist(
  config: HelperConfig,
  enabled: boolean,
  list: string[]
): Promise<{ success: boolean; error?: string }> {
  try {
    const safePath = await guardPath(config.whitelistPath, config.hytaleRoot);
    const data: WhitelistData = { enabled, list };
    const content = JSON.stringify(data, null, 2) + '\n';
    await atomicWriteFile(safePath, content);
    return { success: true };
  } catch (err) {
    return { success: false, error: `Failed to write whitelist: ${String(err).slice(0, 200)}` };
  }
}

/**
 * Read and parse the bans file.
 */
export async function readBans(
  config: HelperConfig
): Promise<{ success: boolean; entries: BanEntry[]; error?: string }> {
  try {
    const safePath = await guardPath(config.bansPath, config.hytaleRoot);

    try {
      await fs.access(safePath);
    } catch {
      return { success: true, entries: [] };
    }

    if (!(await isRegularFile(safePath))) {
      return { success: false, entries: [], error: 'Bans path is not a regular file' };
    }

    const sizeError = await assertFileWithinSizeLimit(safePath, 'Bans');
    if (sizeError) {
      return { success: false, entries: [], error: sizeError };
    }

    const raw = await fs.readFile(safePath, 'utf-8');
    const parsed = JSON.parse(raw);
    const validated = BanFileSchema.parse(parsed);
    return { success: true, entries: validated };
  } catch (err) {
    return { success: false, entries: [], error: `Failed to read bans: ${String(err).slice(0, 200)}` };
  }
}

/**
 * Write the bans file with validated content.
 */
export async function writeBans(
  config: HelperConfig,
  entries: BanEntry[]
): Promise<{ success: boolean; error?: string }> {
  try {
    const validated = BanFileSchema.parse(entries);
    const safePath = await guardPath(config.bansPath, config.hytaleRoot);
    const content = JSON.stringify(validated, null, 2) + '\n';
    await atomicWriteFile(safePath, content);
    return { success: true };
  } catch (err) {
    return { success: false, error: `Failed to write bans: ${String(err).slice(0, 200)}` };
  }
}