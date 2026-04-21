import * as fs from 'fs/promises';
import { createReadStream } from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { pipeline } from 'stream/promises';
import { safeExec } from '../utils/command';
import { guardPath } from '../utils/path-guard';
import { getServerStatus } from './server-control';
import { BACKUP_FILENAME_REGEX, UUID_REGEX } from '@hytale-panel/shared';
import type { HelperConfig } from '../config';
import { enqueueGlobalOperation } from '../utils/operation-lock';

// M2: normalize error messages returned across the RPC boundary so they
// never leak host filesystem paths or raw errno details. The full error
// is still logged on the helper side for operators.
function normalizeError(err: unknown, fallback: string): string {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === 'ENOENT') return 'Resource not found';
  if (code === 'EACCES' || code === 'EPERM') return 'Operation denied';
  console.error('[helper/backup]', err);
  return fallback;
}

export interface BackupInfo {
  id: string;
  filename: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
}

export type BackupOperationType = 'create' | 'restore';
export type BackupOperationStatus = 'running' | 'succeeded' | 'failed' | 'unknown';
export type BackupOperationPhase =
  | 'preparing'
  | 'validating'
  | 'archiving'
  | 'hashing'
  | 'safety-backup'
  | 'extracting'
  | 'recovered'
  | 'complete'
  | 'failed'
  | 'unknown';

export interface BackupOperationState {
  id: string;
  type: BackupOperationType;
  status: BackupOperationStatus;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  phase?: BackupOperationPhase;
  helperInstanceId?: string;
  pid?: number;
  targetFilename?: string;
  backupId?: string;
  restoreSourceFilename?: string;
  restoreCompletionMarker?: string;
  safetyBackupFilename?: string;
  result?: Record<string, unknown>;
  error?: string;
}

interface RestoreCompletionMarker {
  operationId: string;
  sourceFilename: string;
  safetyBackup?: string | null;
  completedAt: string;
  helperInstanceId: string;
}

interface TrackedOperationMetadata {
  phase?: BackupOperationPhase;
  targetFilename?: string;
  backupId?: string;
  restoreSourceFilename?: string;
  restoreCompletionMarker?: string;
  safetyBackupFilename?: string;
}

interface CreateBackupPlan {
  backupId: string;
  filename: string;
}

const BACKUP_OPERATION_STATE_DIR = '.panel-operations';
const BACKUP_RESTORE_MARKER_DIR = 'restore-completions';
const HELPER_INSTANCE_ID = crypto.randomUUID();

function isValidOperationId(value: string): boolean {
  return UUID_REGEX.test(value);
}

function isOperationStatus(value: unknown): value is BackupOperationStatus {
  return value === 'running' || value === 'succeeded' || value === 'failed' || value === 'unknown';
}

function isOperationType(value: unknown): value is BackupOperationType {
  return value === 'create' || value === 'restore';
}

function nowIso(): string {
  return new Date().toISOString();
}

async function getOperationStateDir(config: HelperConfig): Promise<string> {
  return guardPath(path.join(config.backupPath, BACKUP_OPERATION_STATE_DIR), config.backupPath);
}

async function getOperationStateFilePath(config: HelperConfig, operationId: string): Promise<string> {
  const dir = await getOperationStateDir(config);
  return guardPath(path.join(dir, `${operationId}.json`), dir);
}

async function getRestoreMarkerDir(config: HelperConfig): Promise<string> {
  const stateDir = await getOperationStateDir(config);
  return guardPath(path.join(stateDir, BACKUP_RESTORE_MARKER_DIR), stateDir);
}

async function getRestoreCompletionMarkerPath(config: HelperConfig, operationId: string): Promise<string> {
  const markerDir = await getRestoreMarkerDir(config);
  return guardPath(path.join(markerDir, `${operationId}.json`), markerDir);
}

async function persistJsonAtomically(
  parentDir: string,
  filePath: string,
  payload: Record<string, unknown>
): Promise<void> {
  await fs.mkdir(parentDir, { recursive: true, mode: 0o770 });
  const tmpName = `${path.basename(filePath)}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`;
  const tmpPath = await guardPath(path.join(parentDir, tmpName), parentDir);
  await fs.writeFile(tmpPath, JSON.stringify(payload, null, 2), { mode: 0o660 });
  await fs.rename(tmpPath, filePath);
}

async function persistOperationState(config: HelperConfig, state: BackupOperationState): Promise<void> {
  const stateDir = await getOperationStateDir(config);
  const filePath = await getOperationStateFilePath(config, state.id);
  await persistJsonAtomically(stateDir, filePath, state as unknown as Record<string, unknown>);
}

async function persistRestoreCompletionMarker(config: HelperConfig, marker: RestoreCompletionMarker): Promise<void> {
  const markerDir = await getRestoreMarkerDir(config);
  const filePath = await getRestoreCompletionMarkerPath(config, marker.operationId);
  await persistJsonAtomically(markerDir, filePath, marker as unknown as Record<string, unknown>);
}

async function readOperationState(config: HelperConfig, operationId: string): Promise<BackupOperationState | null> {
  if (!isValidOperationId(operationId)) {
    return null;
  }

  const filePath = await getOperationStateFilePath(config, operationId);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<BackupOperationState>;

    if (
      !parsed ||
      typeof parsed.id !== 'string' ||
      !isOperationType(parsed.type) ||
      !isOperationStatus(parsed.status) ||
      typeof parsed.startedAt !== 'string' ||
      typeof parsed.updatedAt !== 'string'
    ) {
      return null;
    }

    return {
      id: parsed.id,
      type: parsed.type,
      status: parsed.status,
      startedAt: parsed.startedAt,
      updatedAt: parsed.updatedAt,
      finishedAt: typeof parsed.finishedAt === 'string' ? parsed.finishedAt : undefined,
      phase: typeof parsed.phase === 'string' ? (parsed.phase as BackupOperationPhase) : undefined,
      helperInstanceId: typeof parsed.helperInstanceId === 'string' ? parsed.helperInstanceId : undefined,
      pid: typeof parsed.pid === 'number' && Number.isFinite(parsed.pid) ? parsed.pid : undefined,
      targetFilename: typeof parsed.targetFilename === 'string' ? parsed.targetFilename : undefined,
      backupId: typeof parsed.backupId === 'string' ? parsed.backupId : undefined,
      restoreSourceFilename:
        typeof parsed.restoreSourceFilename === 'string' ? parsed.restoreSourceFilename : undefined,
      restoreCompletionMarker:
        typeof parsed.restoreCompletionMarker === 'string' ? parsed.restoreCompletionMarker : undefined,
      safetyBackupFilename:
        typeof parsed.safetyBackupFilename === 'string' ? parsed.safetyBackupFilename : undefined,
      result:
        parsed.result && typeof parsed.result === 'object'
          ? (parsed.result as Record<string, unknown>)
          : undefined,
      error: typeof parsed.error === 'string' ? parsed.error : undefined,
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

async function readRestoreCompletionMarker(
  config: HelperConfig,
  operationId: string
): Promise<RestoreCompletionMarker | null> {
  const markerPath = await getRestoreCompletionMarkerPath(config, operationId);
  try {
    const raw = await fs.readFile(markerPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<RestoreCompletionMarker>;
    if (
      !parsed ||
      typeof parsed.operationId !== 'string' ||
      parsed.operationId !== operationId ||
      typeof parsed.sourceFilename !== 'string' ||
      typeof parsed.completedAt !== 'string' ||
      typeof parsed.helperInstanceId !== 'string'
    ) {
      return null;
    }

    return {
      operationId: parsed.operationId,
      sourceFilename: parsed.sourceFilename,
      completedAt: parsed.completedAt,
      helperInstanceId: parsed.helperInstanceId,
      safetyBackup:
        typeof parsed.safetyBackup === 'string' || parsed.safetyBackup === null
          ? parsed.safetyBackup
          : null,
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

async function listOperationStateIds(config: HelperConfig): Promise<string[]> {
  const stateDir = await getOperationStateDir(config);
  try {
    const entries = await fs.readdir(stateDir);
    return entries
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -5))
      .filter((operationId) => isValidOperationId(operationId));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return [];
    }
    throw err;
  }
}

function resolveOperationId(operationId?: string): string | null {
  if (!operationId) {
    return crypto.randomUUID();
  }
  return isValidOperationId(operationId) ? operationId : null;
}

function resolveBackupFilename(label?: string): string {
  const timestamp = nowIso().replace(/[:.]/g, '-');
  const safeLabel = label ? `_${label.replace(/[^a-zA-Z0-9_\-]/g, '')}` : '';
  return `${timestamp}${safeLabel}.tar.gz`;
}

async function persistTerminalOperationState(
  config: HelperConfig,
  state: BackupOperationState,
  status: Exclude<BackupOperationStatus, 'running'>,
  options: {
    phase: BackupOperationPhase;
    result?: Record<string, unknown>;
    error?: string;
  }
): Promise<BackupOperationState> {
  const terminalAt = nowIso();
  const nextState: BackupOperationState = {
    ...state,
    status,
    phase: options.phase,
    updatedAt: terminalAt,
    finishedAt: terminalAt,
    result: options.result,
    error: options.error,
  };

  await persistOperationState(config, nextState);
  return nextState;
}

function shouldRecoverRunningOperation(state: BackupOperationState): boolean {
  if (state.status !== 'running') {
    return false;
  }

  if (!state.helperInstanceId) {
    return true;
  }

  return state.helperInstanceId !== HELPER_INSTANCE_ID;
}

async function validateBackupArchiveForRecovery(
  config: HelperConfig,
  backupFilePath: string
): Promise<{ valid: boolean; reason?: string }> {
  const worldsPath = await guardPath(config.worldsPath, config.hytaleRoot);
  const expectedRootDir = path.basename(worldsPath).replace(/\/+$/, '') || 'worlds';

  const listResult = await safeExec('/usr/bin/tar', ['-tzf', backupFilePath]);
  if (listResult.exitCode !== 0) {
    return { valid: false, reason: 'Archive listing failed during recovery' };
  }

  const entries = listResult.stdout.split('\n').filter(Boolean);
  const entryValidation = validateBackupEntries(entries, expectedRootDir);
  if (!entryValidation.valid) {
    return { valid: false, reason: entryValidation.error ?? 'Archive structure invalid during recovery' };
  }

  return { valid: true };
}

async function reconcileRunningCreateOperation(
  config: HelperConfig,
  state: BackupOperationState
): Promise<BackupOperationState> {
  if (!state.targetFilename) {
    return persistTerminalOperationState(config, state, 'unknown', {
      phase: 'unknown',
      error: 'Create operation outcome unknown after helper restart (missing target filename metadata)',
    });
  }

  const backupFilePath = await guardPath(path.join(config.backupPath, state.targetFilename), config.backupPath);
  try {
    await fs.access(backupFilePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return persistTerminalOperationState(config, state, 'failed', {
        phase: 'failed',
        error: 'Create operation failed after helper restart (archive output missing)',
      });
    }

    throw err;
  }

  const validation = await validateBackupArchiveForRecovery(config, backupFilePath);
  if (!validation.valid) {
    return persistTerminalOperationState(config, state, 'unknown', {
      phase: 'unknown',
      error: validation.reason ?? 'Create operation outcome unknown after helper restart',
    });
  }

  const sha256 = await computeFileSha256(backupFilePath);
  const stat = await fs.stat(backupFilePath);
  const recoveredBackup: BackupInfo = {
    id: state.backupId ?? state.id,
    filename: state.targetFilename,
    sizeBytes: stat.size,
    sha256,
    createdAt: stat.birthtime.toISOString(),
  };

  return persistTerminalOperationState(config, state, 'succeeded', {
    phase: 'recovered',
    result: { backup: recoveredBackup },
  });
}

async function reconcileRunningRestoreOperation(
  config: HelperConfig,
  state: BackupOperationState
): Promise<BackupOperationState> {
  const marker = await readRestoreCompletionMarker(config, state.id);
  if (marker && (!state.restoreSourceFilename || marker.sourceFilename === state.restoreSourceFilename)) {
    return persistTerminalOperationState(config, state, 'succeeded', {
      phase: 'recovered',
      result: { safetyBackup: marker.safetyBackup ?? null },
    });
  }

  if (marker && state.restoreSourceFilename && marker.sourceFilename !== state.restoreSourceFilename) {
    return persistTerminalOperationState(config, state, 'unknown', {
      phase: 'unknown',
      error: 'Restore completion marker did not match operation metadata after helper restart',
    });
  }

  return persistTerminalOperationState(config, state, 'unknown', {
    phase: 'unknown',
    error: 'Restore outcome unknown after helper restart (completion marker missing)',
  });
}

async function reconcileRunningOperationState(
  config: HelperConfig,
  state: BackupOperationState
): Promise<BackupOperationState> {
  try {
    if (!shouldRecoverRunningOperation(state)) {
      return state;
    }

    if (state.type === 'create') {
      return reconcileRunningCreateOperation(config, state);
    }

    return reconcileRunningRestoreOperation(config, state);
  } catch (err) {
    const message = normalizeError(err, 'Operation outcome unknown after helper restart');
    return persistTerminalOperationState(config, state, 'unknown', {
      phase: 'unknown',
      error: message,
    });
  }
}

export async function reconcileRunningBackupOperations(
  config: HelperConfig
): Promise<{ scanned: number; reconciled: number }> {
  const operationIds = await listOperationStateIds(config);

  let scanned = 0;
  let reconciled = 0;

  for (const operationId of operationIds) {
    const operation = await readOperationState(config, operationId);
    if (!operation || operation.status !== 'running') {
      continue;
    }

    scanned += 1;
    const nextState = await reconcileRunningOperationState(config, operation);
    if (nextState.status !== 'running') {
      reconciled += 1;
    }
  }

  return { scanned, reconciled };
}

async function persistFallbackFailedState(
  config: HelperConfig,
  type: BackupOperationType,
  operationId: string,
  error: string,
  metadata: TrackedOperationMetadata
): Promise<void> {
  const timestamp = nowIso();
  await persistOperationState(config, {
    id: operationId,
    type,
    status: 'failed',
    phase: 'failed',
    startedAt: timestamp,
    updatedAt: timestamp,
    finishedAt: timestamp,
    helperInstanceId: HELPER_INSTANCE_ID,
    pid: process.pid,
    targetFilename: metadata.targetFilename,
    backupId: metadata.backupId,
    restoreSourceFilename: metadata.restoreSourceFilename,
    restoreCompletionMarker: metadata.restoreCompletionMarker,
    safetyBackupFilename: metadata.safetyBackupFilename,
    error,
  });
}

async function runTrackedBackupOperation<T extends Record<string, unknown>>(
  config: HelperConfig,
  type: BackupOperationType,
  operationId: string,
  metadata: TrackedOperationMetadata,
  run: (helpers: {
    setRunningState: (phase: BackupOperationPhase, patch?: TrackedOperationMetadata) => Promise<void>;
  }) => Promise<{ success: boolean; result?: T; error?: string }>
): Promise<{ success: boolean; operationId: string; result?: T; error?: string }> {
  const startedAt = nowIso();
  let operationState: BackupOperationState = {
    id: operationId,
    type,
    status: 'running',
    startedAt,
    updatedAt: startedAt,
    phase: metadata.phase ?? 'preparing',
    helperInstanceId: HELPER_INSTANCE_ID,
    pid: process.pid,
    targetFilename: metadata.targetFilename,
    backupId: metadata.backupId,
    restoreSourceFilename: metadata.restoreSourceFilename,
    restoreCompletionMarker: metadata.restoreCompletionMarker,
    safetyBackupFilename: metadata.safetyBackupFilename,
  };

  await persistOperationState(config, operationState);

  const setRunningState = async (phase: BackupOperationPhase, patch?: TrackedOperationMetadata): Promise<void> => {
    operationState = {
      ...operationState,
      ...patch,
      status: 'running',
      phase,
      updatedAt: nowIso(),
    };
    await persistOperationState(config, operationState);
  };

  const opResult = await run({ setRunningState });

  if (opResult.success) {
    const terminalState = await persistTerminalOperationState(config, operationState, 'succeeded', {
      phase: 'complete',
      result: opResult.result,
    });
    return { success: true, operationId: terminalState.id, result: opResult.result };
  }

  const error = opResult.error ?? 'Backup operation failed';
  const terminalState = await persistTerminalOperationState(config, operationState, 'failed', {
    phase: 'failed',
    error,
  });
  return { success: false, operationId: terminalState.id, error };
}

async function computeFileSha256(filePath: string): Promise<string> {
  const hasher = crypto.createHash('sha256');
  await pipeline(createReadStream(filePath), hasher);
  return hasher.digest('hex');
}

export function validateBackupEntries(entries: string[], expectedRootDir: string): { valid: boolean; error?: string } {
  if (entries.length === 0) {
    return { valid: false, error: 'Backup archive is empty or invalid' };
  }

  for (const entry of entries) {
    if (entry.startsWith('/') || entry.includes('..')) {
      return { valid: false, error: 'Backup contains unsafe paths (absolute or traversal)' };
    }

    if (entry !== expectedRootDir && !entry.startsWith(`${expectedRootDir}/`)) {
      return { valid: false, error: `Backup contains unexpected top-level path: ${entry}` };
    }
  }

  return { valid: true };
}

export function validateBackupEntryTypes(verboseEntries: string[]): { valid: boolean; error?: string } {
  for (const entry of verboseEntries) {
    const type = entry[0];
    if (!type || !['-', 'd'].includes(type)) {
      return {
        valid: false,
        error: 'Backup contains unsupported entry types (only regular files and directories are allowed)',
      };
    }
  }

  return { valid: true };
}

/**
 * Create a backup of the Hytale server worlds directory.
 */
async function _createBackup(
  config: HelperConfig,
  plan: CreateBackupPlan,
  setRunningState: (phase: BackupOperationPhase) => Promise<void>
): Promise<{ success: boolean; backup?: BackupInfo; error?: string }> {
  try {
    await fs.mkdir(config.backupPath, { recursive: true, mode: 0o770 });

    const backupFilePath = await guardPath(path.join(config.backupPath, plan.filename), config.backupPath);
    const worldsPath = await guardPath(config.worldsPath, config.hytaleRoot);

    await setRunningState('validating');
    try {
      await fs.access(worldsPath);
    } catch {
      return { success: false, error: 'Worlds directory not found' };
    }

    await setRunningState('archiving');
    const result = await safeExec('/usr/bin/tar', [
      '-czf',
      backupFilePath,
      '-C',
      path.dirname(worldsPath),
      path.basename(worldsPath),
    ], { timeout: 300_000 }); // 5 minute timeout for large worlds

    if (result.exitCode !== 0) {
      console.error('[helper/backup] tar create stderr:', result.stderr);
      return { success: false, error: 'Backup operation failed' };
    }

    await setRunningState('hashing');
    const sha256 = await computeFileSha256(backupFilePath);
    const stat = await fs.stat(backupFilePath);

    return {
      success: true,
      backup: {
        id: plan.backupId,
        filename: plan.filename,
        sizeBytes: stat.size,
        sha256,
        createdAt: nowIso(),
      },
    };
  } catch (err) {
    return { success: false, error: normalizeError(err, 'Backup operation failed') };
  }
}

export async function createBackup(
  config: HelperConfig,
  label?: string,
  operationId?: string
): Promise<{ success: boolean; backup?: BackupInfo; operationId?: string; error?: string }> {
  const resolvedOperationId = resolveOperationId(operationId);
  if (!resolvedOperationId) {
    return { success: false, error: 'Invalid operation ID' };
  }

  const plan: CreateBackupPlan = {
    backupId: crypto.randomUUID(),
    filename: resolveBackupFilename(label),
  };

  try {
    const tracked = await runTrackedBackupOperation(
      config,
      'create',
      resolvedOperationId,
      {
        phase: 'preparing',
        targetFilename: plan.filename,
        backupId: plan.backupId,
      },
      async ({ setRunningState }) => {
        const result = await _createBackup(config, plan, (phase) => setRunningState(phase));
        return {
          success: result.success,
          result: result.success && result.backup ? { backup: result.backup } : undefined,
          error: result.error,
        };
      }
    );

    if (!tracked.success) {
      return { success: false, operationId: resolvedOperationId, error: tracked.error };
    }

    const backup = (tracked.result as { backup?: BackupInfo } | undefined)?.backup;
    if (!backup) {
      return { success: false, operationId: resolvedOperationId, error: 'Backup operation failed' };
    }

    return { success: true, backup, operationId: resolvedOperationId };
  } catch (err) {
    const normalized = normalizeError(err, 'Backup operation failed');
    try {
      await persistFallbackFailedState(config, 'create', resolvedOperationId, normalized, {
        phase: 'failed',
        targetFilename: plan.filename,
        backupId: plan.backupId,
      });
    } catch {
      // If state persistence fails during error handling, surface the operation error anyway.
    }
    return { success: false, operationId: resolvedOperationId, error: normalized };
  }
}

/**
 * List all available backups.
 */
export async function listBackups(
  config: HelperConfig
): Promise<{ success: boolean; backups: Array<{ filename: string; sizeBytes: number; createdAt: string }>; error?: string }> {
  try {
    await fs.mkdir(config.backupPath, { recursive: true, mode: 0o770 });
    const files = await fs.readdir(config.backupPath);

    const backups: Array<{ filename: string; sizeBytes: number; createdAt: string }> = [];

    for (const file of files) {
      if (!BACKUP_FILENAME_REGEX.test(file)) continue;

      const filePath = await guardPath(path.join(config.backupPath, file), config.backupPath);
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) continue;

      backups.push({
        filename: file,
        sizeBytes: stat.size,
        createdAt: stat.birthtime.toISOString(),
      });
    }

    backups.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return { success: true, backups };
  } catch (err) {
    return { success: false, backups: [], error: normalizeError(err, 'Backup list failed') };
  }
}

/**
 * Restore a backup. Server MUST be stopped first.
 * Creates a safety snapshot before restoring.
 */
async function _restoreBackup(
  config: HelperConfig,
  filename: string,
  operationId: string,
  setRunningState: (phase: BackupOperationPhase, patch?: TrackedOperationMetadata) => Promise<void>
): Promise<{ success: boolean; safetyBackup?: string; error?: string }> {
  try {
    if (!BACKUP_FILENAME_REGEX.test(filename)) {
      return { success: false, error: 'Invalid backup filename' };
    }

    await setRunningState('validating');

    const status = await getServerStatus(config);
    if (status.running) {
      return { success: false, error: 'Cannot restore while server is running. Stop the server first.' };
    }

    const backupFilePath = await guardPath(path.join(config.backupPath, filename), config.backupPath);

    try {
      await fs.access(backupFilePath);
    } catch {
      return { success: false, error: 'Backup file not found' };
    }

    const worldsPath = await guardPath(config.worldsPath, config.hytaleRoot);
    const expectedRootDir = path.basename(worldsPath).replace(/\/+$/, '') || 'worlds';

    const listResult = await safeExec('/usr/bin/tar', ['-tzf', backupFilePath]);
    if (listResult.exitCode !== 0) {
      return { success: false, error: 'Backup archive is corrupted or invalid' };
    }

    const entries = listResult.stdout.split('\n').filter(Boolean);
    const entryValidation = validateBackupEntries(entries, expectedRootDir);
    if (!entryValidation.valid) {
      return { success: false, error: entryValidation.error };
    }

    const verboseResult = await safeExec('/usr/bin/tar', ['-tvzf', backupFilePath]);
    if (verboseResult.exitCode !== 0) {
      return { success: false, error: 'Backup archive is corrupted or invalid' };
    }

    const typeValidation = validateBackupEntryTypes(verboseResult.stdout.split('\n').filter(Boolean));
    if (!typeValidation.valid) {
      return { success: false, error: typeValidation.error };
    }

    await setRunningState('safety-backup');

    // Create safety snapshot before restore. M5: if the safety backup
    // fails we must NOT proceed — the subsequent rm -rf on worlds/ would
    // otherwise cause unrecoverable data loss. Abort with a clear error.
    const safetyResult = await createBackup(config, 'safety-pre-restore');
    if (!safetyResult.success) {
      console.error(
        '[helper/backup] safety-pre-restore backup failed; aborting restore:',
        safetyResult.error
      );
      return {
        success: false,
        error: 'Pre-restore safety backup failed; aborting restore to prevent data loss',
      };
    }

    const safetyBackupName = safetyResult.backup?.filename;
    await setRunningState('extracting', { safetyBackupFilename: safetyBackupName });

    try {
      await fs.rm(worldsPath, { recursive: true, force: true });
    } catch {
      // May not exist
    }

    const extractResult = await safeExec('/usr/bin/tar', [
      '-xzf',
      backupFilePath,
      '--no-same-owner',
      '--no-same-permissions',
      '-C',
      path.dirname(worldsPath),
    ], { timeout: 300_000 });

    if (extractResult.exitCode !== 0) {
      console.error('[helper/backup] tar extract stderr:', extractResult.stderr);
      return { success: false, error: 'Backup operation failed' };
    }

    await persistRestoreCompletionMarker(config, {
      operationId,
      sourceFilename: filename,
      safetyBackup: safetyBackupName ?? null,
      completedAt: nowIso(),
      helperInstanceId: HELPER_INSTANCE_ID,
    });

    return { success: true, safetyBackup: safetyBackupName };
  } catch (err) {
    return { success: false, error: normalizeError(err, 'Backup operation failed') };
  }
}

export function restoreBackup(
  config: HelperConfig,
  filename: string,
  operationId?: string
): Promise<{ success: boolean; safetyBackup?: string; operationId?: string; error?: string }> {
  const resolvedOperationId = resolveOperationId(operationId);
  if (!resolvedOperationId) {
    return Promise.resolve({ success: false, error: 'Invalid operation ID' });
  }

  const initialMetadata: TrackedOperationMetadata = {
    phase: 'preparing',
    restoreSourceFilename: filename,
    restoreCompletionMarker: `${resolvedOperationId}.json`,
  };

  return enqueueGlobalOperation(async () => {
    try {
      const tracked = await runTrackedBackupOperation(
        config,
        'restore',
        resolvedOperationId,
        initialMetadata,
        async ({ setRunningState }) => {
          const result = await _restoreBackup(config, filename, resolvedOperationId, setRunningState);
          return {
            success: result.success,
            result: result.success ? { safetyBackup: result.safetyBackup ?? null } : undefined,
            error: result.error,
          };
        }
      );

      if (!tracked.success) {
        return { success: false, operationId: resolvedOperationId, error: tracked.error };
      }

      const safetyBackup = (tracked.result as { safetyBackup?: string | null } | undefined)?.safetyBackup ?? undefined;
      return { success: true, operationId: resolvedOperationId, safetyBackup };
    } catch (err) {
      const normalized = normalizeError(err, 'Backup operation failed');
      try {
        await persistFallbackFailedState(config, 'restore', resolvedOperationId, normalized, {
          ...initialMetadata,
          phase: 'failed',
        });
      } catch {
        // Best effort; preserve original operation failure.
      }
      return { success: false, operationId: resolvedOperationId, error: normalized };
    }
  });
}

/**
 * Delete a backup file.
 */
export async function deleteBackup(
  config: HelperConfig,
  filename: string
): Promise<{ success: boolean; error?: string }> {
  try {
    if (!BACKUP_FILENAME_REGEX.test(filename)) {
      return { success: false, error: 'Invalid backup filename' };
    }

    const backupFilePath = await guardPath(path.join(config.backupPath, filename), config.backupPath);

    await fs.unlink(backupFilePath);
    return { success: true };
  } catch (err) {
    return { success: false, error: normalizeError(err, 'Backup operation failed') };
  }
}

/**
 * Compute the SHA256 of an existing backup file. Used by the API to verify
 * integrity against the recorded hash before a restore.
 */
export async function hashBackup(
  config: HelperConfig,
  filename: string
): Promise<{ success: boolean; sha256?: string; error?: string }> {
  try {
    if (!BACKUP_FILENAME_REGEX.test(filename)) {
      return { success: false, error: 'Invalid backup filename' };
    }

    const backupFilePath = await guardPath(path.join(config.backupPath, filename), config.backupPath);

    try {
      await fs.access(backupFilePath);
    } catch {
      return { success: false, error: 'Backup file not found' };
    }

    const sha256 = await computeFileSha256(backupFilePath);
    return { success: true, sha256 };
  } catch (err) {
    return { success: false, error: normalizeError(err, 'Backup operation failed') };
  }
}

export async function getBackupOperationStatus(
  config: HelperConfig,
  operationId: string
): Promise<{ success: boolean; found: boolean; operation?: BackupOperationState; error?: string }> {
  try {
    if (!isValidOperationId(operationId)) {
      return { success: false, found: false, error: 'Invalid operation ID' };
    }

    const operation = await readOperationState(config, operationId);
    if (!operation) {
      return { success: true, found: false };
    }

    const reconciled = operation.status === 'running'
      ? await reconcileRunningOperationState(config, operation)
      : operation;

    return { success: true, found: true, operation: reconciled };
  } catch (err) {
    return { success: false, found: false, error: normalizeError(err, 'Backup operation state lookup failed') };
  }
}
