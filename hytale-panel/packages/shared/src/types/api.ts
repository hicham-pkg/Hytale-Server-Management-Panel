import type { User, AuditLog, BackupMeta, CrashEvent, SystemStats, ProcessStats } from './models';
import type { ServerStatus } from '../schemas/server';
import type { BanEntry } from '../schemas/bans';

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface LoginResponse {
  requires2fa: boolean;
  requiresTotpSetup?: boolean;
  user?: Pick<User, 'id' | 'username' | 'role' | 'totpEnabled'>;
  csrfToken?: string;
}

export interface MeResponse {
  user: Pick<User, 'id' | 'username' | 'role' | 'totpEnabled'>;
  csrfToken?: string;
}

export interface TotpSetupResponse {
  secret: string;
  qrDataUrl: string;
}

export interface ServerStatusResponse extends ServerStatus {
  serviceName: string;
}

export interface WhitelistResponse {
  enabled: boolean;
  list: string[];
  serverRunning: boolean;
}

export interface BanListResponse {
  entries: BanEntry[];
}

export interface BackupListResponse {
  backups: BackupMeta[];
  helperOffline?: boolean;
}

export type BackupJobType = 'create' | 'restore';
export type BackupJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'interrupted';

export interface BackupJob {
  id: string;
  type: BackupJobType;
  status: BackupJobStatus;
  requestPayload: Record<string, unknown>;
  resultPayload: Record<string, unknown> | null;
  error: string | null;
  requestedBy: string | null;
  workerId: string | null;
  leaseExpiresAt: string | null;
  lastHeartbeatAt: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

export interface BackupJobResponse {
  job: BackupJob;
}

export interface BackupJobListResponse {
  jobs: BackupJob[];
}

export interface CrashListResponse {
  events: CrashEvent[];
  total: number;
}

export interface AuditLogListResponse {
  logs: AuditLog[];
  total: number;
}

export interface StatsResponse {
  system: SystemStats;
  process: ProcessStats;
}

export type ModStatus = 'active' | 'disabled';

export interface ModInfo {
  name: string;
  sizeBytes: number;
  sha256: string;
  modifiedAt: string;
  status: ModStatus;
}

export interface ModListResponse {
  active: ModInfo[];
  disabled: ModInfo[];
}

export interface StagedModInfo {
  stagedId: string;
  originalName: string;
  sanitizedName: string;
  sizeBytes: number;
  sha256: string;
  extension: 'jar' | 'zip';
  stagedAt: string;
}

export interface ModInstallResponse {
  mod: ModInfo;
  backupName: string;
}

export interface ModActionResponse {
  message: string;
  backupName?: string;
  removedFrom?: ModStatus;
}

export interface ModRestartVerifyResponse {
  restartSucceeded: boolean;
  startupOk: boolean;
  verificationStatus: 'passed' | 'failed' | 'inconclusive';
  errors: string[];
  rollbackPerformed: boolean;
  rollbackBackupName?: string;
  rollbackRestartSucceeded?: boolean;
  message: string;
}

export interface PaginationQuery {
  page?: number;
  limit?: number;
}

/**
 * Shape returned by GET /api/system/updates/status. The GitHub token (if any)
 * is intentionally absent — it is never sent to the browser.
 */
export interface PanelUpdateStatus {
  currentVersion: string;
  currentCommit?: string;
  latestVersion: string | null;
  latestTag: string | null;
  checkStatus: 'ok' | 'unable_to_check';
  updateAvailable: boolean;
  releaseUrl: string | null;
  releaseName: string | null;
  publishedAt: string | null;
  prerelease: boolean;
  checkedAt: string;
  fromCache: boolean;
  error?: string;
}
