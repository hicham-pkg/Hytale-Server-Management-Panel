import { desc, eq, and, gte, lte, sql } from 'drizzle-orm';
import { getDb, schema } from '../db';
import type { AuditLog } from '@hytale-panel/shared';

const { auditLogs } = schema;

export interface AuditEntry {
  userId: string | null;
  action: string;
  target?: string;
  details?: Record<string, unknown>;
  ipAddress?: string;
  success: boolean;
}

/**
 * Record an audit log entry.
 */
export async function logAudit(entry: AuditEntry): Promise<void> {
  const db = getDb();
  try {
    await db.insert(auditLogs).values({
      userId: entry.userId,
      action: entry.action,
      target: entry.target ?? null,
      details: entry.details ?? null,
      ipAddress: entry.ipAddress ?? null,
      success: entry.success,
    });
  } catch (err) {
    // Audit logging should never crash the application
    console.error('Failed to write audit log:', err);
  }
}

/**
 * Query audit logs with pagination.
 */
export async function queryAuditLogs(options: {
  page?: number;
  limit?: number;
  userId?: string;
  action?: string;
  since?: string;
  until?: string;
}): Promise<{ logs: AuditLog[]; total: number }> {
  const db = getDb();
  const page = Math.max(options.page ?? 1, 1);
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const offset = (page - 1) * limit;

  const conditions = [];
  if (options.userId) conditions.push(eq(auditLogs.userId, options.userId));
  if (options.action) conditions.push(eq(auditLogs.action, options.action));
  if (options.since) conditions.push(gte(auditLogs.createdAt, new Date(options.since)));
  if (options.until) conditions.push(lte(auditLogs.createdAt, new Date(options.until)));

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [logs, countResult] = await Promise.all([
    db
      .select()
      .from(auditLogs)
      .where(where)
      .orderBy(desc(auditLogs.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)` })
      .from(auditLogs)
      .where(where),
  ]);

  return {
    logs: logs.map((l) => ({
      id: l.id,
      userId: l.userId,
      action: l.action,
      target: l.target,
      details: l.details as Record<string, unknown> | null,
      ipAddress: l.ipAddress,
      success: l.success,
      createdAt: l.createdAt.toISOString(),
    })),
    total: Number(countResult[0]?.count ?? 0),
  };
}

/**
 * Export all audit logs as JSON array.
 */
export async function exportAuditLogs(): Promise<AuditLog[]> {
  const db = getDb();
  const logs = await db
    .select()
    .from(auditLogs)
    .orderBy(desc(auditLogs.createdAt))
    .limit(10_000);

  return logs.map((l) => ({
    id: l.id,
    userId: l.userId,
    action: l.action,
    target: l.target,
    details: l.details as Record<string, unknown> | null,
    ipAddress: l.ipAddress,
    success: l.success,
    createdAt: l.createdAt.toISOString(),
  }));
}