import type { UserRole, Severity } from '../constants';

export type CrashEventStatus = 'active' | 'historical' | 'archived';

export interface User {
  id: string;
  username: string;
  role: UserRole;
  totpEnabled: boolean;
  failedLoginAttempts: number;
  lockedUntil: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Session {
  id: string;
  userId: string;
  ipAddress: string;
  userAgent: string | null;
  pending2fa: boolean;
  expiresAt: string;
  createdAt: string;
}

export interface AuditLog {
  id: string;
  userId: string | null;
  action: string;
  target: string | null;
  details: Record<string, unknown> | null;
  ipAddress: string | null;
  success: boolean;
  createdAt: string;
}

export interface BackupMeta {
  id: string;
  filename: string;
  label: string | null;
  sizeBytes: number;
  sha256: string;
  createdBy: string | null;
  createdAt: string;
  helperOffline?: boolean;
}

export interface CrashEvent {
  id: string;
  severity: Severity;
  pattern: string;
  summary: string;
  rawLog: string | null;
  detectedAt: string;
  status: CrashEventStatus;
  archivedAt: string | null;
  archivedBy: string | null;
}

export interface SystemStats {
  cpuUsagePercent: number;
  memoryUsedMb: number;
  memoryTotalMb: number;
  memoryUsagePercent: number;
  diskUsedGb: number;
  diskTotalGb: number;
  diskUsagePercent: number;
}

export interface ProcessStats {
  pid: number | null;
  cpuPercent: number | null;
  memoryMb: number | null;
  uptime: string | null;
}
