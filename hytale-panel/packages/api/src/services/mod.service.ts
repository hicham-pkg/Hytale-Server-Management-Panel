import { createHash, randomUUID } from 'crypto';
import { createWriteStream } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { once } from 'events';
import type { Readable } from 'stream';
import {
  MOD_FILENAME_REGEX,
  UUID_REGEX,
  type HelperOperation,
  type ModActionResponse,
  type ModInfo,
  type ModInstallResponse,
  type ModListResponse,
  type ModRestartVerifyResponse,
  type StagedModInfo,
} from '@hytale-panel/shared';
import { callHelper } from './helper-client';

const ZIP_SIGNATURES = ['504b0304', '504b0506', '504b0708'];
const STAGED_UPLOAD_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const STAGED_TMP_MAX_AGE_MS = 60 * 60 * 1000;
const MAX_STAGED_UPLOAD_FILES = 50;
const MAX_STAGING_BYTES_MULTIPLIER = 10;
const STAGED_UPLOAD_FILE_REGEX = /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.(upload|json|upload\.tmp)$/i;

function normalizeHeaderFilename(rawFilename: string): string {
  try {
    return decodeURIComponent(rawFilename);
  } catch {
    return rawFilename;
  }
}

export function sanitizeUploadedModFilename(rawFilename: string): {
  originalName: string;
  sanitizedName: string;
  extension: 'jar' | 'zip';
} {
  const originalName = normalizeHeaderFilename(rawFilename).trim();
  if (
    !originalName ||
    originalName.includes('/') ||
    originalName.includes('\\') ||
    originalName.startsWith('.') ||
    /[\x00-\x1F\x7F]/.test(originalName)
  ) {
    throw new Error('Invalid uploaded filename');
  }

  const extMatch = originalName.match(/\.([A-Za-z0-9]+)$/);
  const extension = extMatch?.[1]?.toLowerCase();
  if (extension !== 'jar' && extension !== 'zip') {
    throw new Error('Only .jar and .zip mod uploads are allowed');
  }

  const baseName = originalName.slice(0, -(extension.length + 1));
  const sanitizedBase = baseName
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^[._-]+/, '')
    .slice(0, 110);
  const finalBase = sanitizedBase || 'mod';
  const sanitizedName = `${finalBase}.${extension}`;

  if (!MOD_FILENAME_REGEX.test(sanitizedName)) {
    throw new Error('Uploaded filename cannot be safely normalized');
  }

  return { originalName, sanitizedName, extension };
}

function guardStagingPath(filePath: string, stagingPath: string): string {
  const resolved = path.resolve(filePath);
  const base = path.resolve(stagingPath);
  if (!resolved.startsWith(base + path.sep) && resolved !== base) {
    throw new Error('Upload staging path escaped its allowed directory');
  }
  return resolved;
}

function hasZipSignature(bytes: Buffer): boolean {
  if (bytes.length < 4) {
    return false;
  }
  return ZIP_SIGNATURES.includes(bytes.subarray(0, 4).toString('hex'));
}

export async function cleanupStaleStagedUploads(
  stagingPath: string,
  nowMs = Date.now()
): Promise<{ removed: number }> {
  await fs.mkdir(stagingPath, { recursive: true, mode: 0o2770 });
  const entries = await fs.readdir(stagingPath, { withFileTypes: true }).catch(() => []);
  let removed = 0;

  await Promise.all(entries.map(async (entry) => {
    if (!entry.isFile() || !STAGED_UPLOAD_FILE_REGEX.test(entry.name)) {
      return;
    }

    const filePath = guardStagingPath(path.join(stagingPath, entry.name), stagingPath);
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat) {
      return;
    }

    const maxAgeMs = entry.name.endsWith('.upload.tmp')
      ? STAGED_TMP_MAX_AGE_MS
      : STAGED_UPLOAD_MAX_AGE_MS;
    if (nowMs - stat.mtimeMs < maxAgeMs) {
      return;
    }

    await fs.rm(filePath, { force: true });
    removed += 1;
  }));

  return { removed };
}

async function assertStagingQuota(
  stagingPath: string,
  maxUploadBytes: number,
  incomingBytes?: number
): Promise<void> {
  const entries = await fs.readdir(stagingPath, { withFileTypes: true }).catch(() => []);
  let uploadFiles = 0;
  let totalBytes = 0;

  await Promise.all(entries.map(async (entry) => {
    if (!entry.isFile() || !STAGED_UPLOAD_FILE_REGEX.test(entry.name)) {
      return;
    }

    const filePath = guardStagingPath(path.join(stagingPath, entry.name), stagingPath);
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat) {
      return;
    }

    totalBytes += stat.size;
    if (entry.name.endsWith('.upload') || entry.name.endsWith('.upload.tmp')) {
      uploadFiles += 1;
    }
  }));

  const reservedIncomingBytes = incomingBytes ?? maxUploadBytes;
  const maxStagingBytes = maxUploadBytes * MAX_STAGING_BYTES_MULTIPLIER;
  if (uploadFiles >= MAX_STAGED_UPLOAD_FILES || totalBytes + reservedIncomingBytes > maxStagingBytes) {
    throw new Error('Mod upload staging area is full; install or wait for stale staged uploads to be cleaned');
  }
}

async function callModHelper<T>(
  operation: HelperOperation,
  params: Record<string, unknown> = {},
  timeoutMs = 60_000
): Promise<T> {
  const result = await callHelper(operation, params, { timeoutMs });
  if (!result.success) {
    throw new Error(result.error ?? `${operation} failed`);
  }
  return result.data as T;
}

export async function stageModUpload(options: {
  stream: Readable;
  rawFilename: string;
  stagingPath: string;
  maxBytes: number;
  contentLength?: number;
}): Promise<StagedModInfo> {
  const filename = sanitizeUploadedModFilename(options.rawFilename);
  if (options.contentLength !== undefined && options.contentLength > options.maxBytes) {
    throw new Error(`Mod upload exceeds the ${Math.floor(options.maxBytes / 1024 / 1024)} MB limit`);
  }

  await cleanupStaleStagedUploads(options.stagingPath);
  await assertStagingQuota(options.stagingPath, options.maxBytes, options.contentLength);

  const stagedId = randomUUID();
  const tmpPath = guardStagingPath(path.join(options.stagingPath, `${stagedId}.upload.tmp`), options.stagingPath);
  const stagedPath = guardStagingPath(path.join(options.stagingPath, `${stagedId}.upload`), options.stagingPath);
  const metadataPath = guardStagingPath(path.join(options.stagingPath, `${stagedId}.json`), options.stagingPath);
  const hash = createHash('sha256');
  let signatureBytes = Buffer.alloc(0);
  let sizeBytes = 0;
  const out = createWriteStream(tmpPath, { flags: 'wx', mode: 0o660 });
  const outError = new Promise<never>((_, reject) => {
    out.once('error', reject);
  });

  try {
    for await (const chunk of options.stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      sizeBytes += buffer.length;
      if (sizeBytes > options.maxBytes) {
        throw new Error(`Mod upload exceeds the ${Math.floor(options.maxBytes / 1024 / 1024)} MB limit`);
      }

      if (signatureBytes.length < 4) {
        signatureBytes = Buffer.concat([
          signatureBytes,
          buffer.subarray(0, Math.max(0, 4 - signatureBytes.length)),
        ]);
      }

      hash.update(buffer);
      if (!out.write(buffer)) {
        await Promise.race([once(out, 'drain'), outError]);
      }
    }

    if (sizeBytes === 0) {
      throw new Error('Empty mod uploads are not allowed');
    }

    if (!hasZipSignature(signatureBytes)) {
      throw new Error('Uploaded mod is not a valid ZIP/JAR file');
    }

    out.end();
    await Promise.race([once(out, 'finish'), outError]);

    const stagedAt = new Date().toISOString();
    const staged: StagedModInfo = {
      stagedId,
      originalName: filename.originalName,
      sanitizedName: filename.sanitizedName,
      sizeBytes,
      sha256: hash.digest('hex'),
      extension: filename.extension,
      stagedAt,
    };

    await fs.rename(tmpPath, stagedPath);
    await fs.writeFile(metadataPath, JSON.stringify(staged, null, 2), { mode: 0o660 });
    return staged;
  } catch (err) {
    out.destroy();
    await Promise.all([
      fs.rm(tmpPath, { force: true }),
      fs.rm(stagedPath, { force: true }),
      fs.rm(metadataPath, { force: true }),
    ]);
    throw err;
  }
}

export function listMods(): Promise<ModListResponse> {
  return callModHelper<ModListResponse>('mods.list');
}

export function installStagedMod(params: {
  stagedId: string;
  sanitizedName: string;
  sha256: string;
  replace?: boolean;
}): Promise<ModInstallResponse> {
  return callModHelper<ModInstallResponse>('mods.installStaged', params, 300_000);
}

export function disableMod(name: string): Promise<ModActionResponse> {
  return callModHelper<ModActionResponse>('mods.disable', { name });
}

export function enableMod(name: string): Promise<ModActionResponse> {
  return callModHelper<ModActionResponse>('mods.enable', { name });
}

export function removeMod(name: string): Promise<ModActionResponse> {
  return callModHelper<ModActionResponse>('mods.remove', { name });
}

export function backupMods(): Promise<ModActionResponse> {
  return callModHelper<ModActionResponse>('mods.backup');
}

export function rollbackMods(backupName?: string): Promise<ModActionResponse> {
  return callModHelper<ModActionResponse>('mods.rollback', backupName ? { backupName } : {}, 300_000);
}

export function restartAndVerifyMods(autoRollback = false): Promise<ModRestartVerifyResponse> {
  return callHelper('mods.restartVerify', { autoRollback }, { timeoutMs: 180_000 }).then((result) => {
    if (result.data) {
      return result.data as ModRestartVerifyResponse;
    }
    if (!result.success) {
      throw new Error(result.error ?? 'Mod restart verification failed');
    }
    throw new Error('Mod restart verification returned no result');
  });
}

export function assertModNameForApi(name: string): string {
  if (!MOD_FILENAME_REGEX.test(name) || name.includes('/') || name.includes('\\') || name.startsWith('.')) {
    throw new Error('Invalid mod filename');
  }
  return name;
}

export function assertStagedIdForApi(stagedId: string): string {
  if (!UUID_REGEX.test(stagedId)) {
    throw new Error('Invalid staged mod id');
  }
  return stagedId;
}
