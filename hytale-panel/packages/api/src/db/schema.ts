import { pgTable, uuid, varchar, boolean, integer, timestamp, jsonb, bigint, text, index } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  username: varchar('username', { length: 50 }).unique().notNull(),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  role: varchar('role', { length: 20 }).notNull(),
  totpSecret: varchar('totp_secret', { length: 255 }),
  totpEnabled: boolean('totp_enabled').default(false).notNull(),
  failedLoginAttempts: integer('failed_login_attempts').default(0).notNull(),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  lastTotpCounter: bigint('last_totp_counter', { mode: 'number' }).default(0).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  ipAddress: varchar('ip_address', { length: 45 }).notNull(),
  userAgent: varchar('user_agent', { length: 500 }),
  pending2fa: boolean('pending_2fa').default(false).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  userIdIdx: index('idx_sessions_user_id').on(table.userId),
  expiresAtIdx: index('idx_sessions_expires_at').on(table.expiresAt),
}));

export const auditLogs = pgTable('audit_logs', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  action: varchar('action', { length: 100 }).notNull(),
  target: varchar('target', { length: 200 }),
  details: jsonb('details'),
  ipAddress: varchar('ip_address', { length: 45 }),
  success: boolean('success').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  createdAtIdx: index('idx_audit_logs_created_at').on(table.createdAt),
  userCreatedIdx: index('idx_audit_logs_user_created').on(table.userId, table.createdAt),
}));

export const backupMetadata = pgTable('backup_metadata', {
  id: uuid('id').primaryKey(),
  filename: varchar('filename', { length: 255 }).notNull(),
  label: varchar('label', { length: 50 }),
  sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
  sha256: varchar('sha256', { length: 64 }).notNull(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  createdAtIdx: index('idx_backup_metadata_created_at').on(table.createdAt),
}));

export const backupJobs = pgTable('backup_jobs', {
  id: uuid('id').defaultRandom().primaryKey(),
  type: varchar('type', { length: 20 }).notNull(),
  status: varchar('status', { length: 20 }).notNull(),
  requestPayload: jsonb('request_payload').notNull(),
  resultPayload: jsonb('result_payload'),
  error: text('error'),
  requestedBy: uuid('requested_by').references(() => users.id, { onDelete: 'set null' }),
  workerId: varchar('worker_id', { length: 100 }),
  leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
  lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  statusCreatedAtIdx: index('idx_backup_jobs_status_created_at').on(table.status, table.createdAt),
  requestedByCreatedAtIdx: index('idx_backup_jobs_requested_by_created_at').on(table.requestedBy, table.createdAt),
}));

export const crashEvents = pgTable('crash_events', {
  id: uuid('id').defaultRandom().primaryKey(),
  severity: varchar('severity', { length: 20 }).notNull(),
  pattern: varchar('pattern', { length: 100 }).notNull(),
  summary: text('summary').notNull(),
  rawLog: text('raw_log'),
  detectedAt: timestamp('detected_at', { withTimezone: true }).defaultNow().notNull(),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  archivedBy: uuid('archived_by').references(() => users.id, { onDelete: 'set null' }),
}, (table) => ({
  detectedAtIdx: index('idx_crash_events_detected_at').on(table.detectedAt),
  severityIdx: index('idx_crash_events_severity').on(table.severity),
  archivedAtIdx: index('idx_crash_events_archived_at').on(table.archivedAt),
}));

export const crashScanState = pgTable('crash_scan_state', {
  id: integer('id').primaryKey().default(1),
  cursorSince: timestamp('cursor_since', { withTimezone: true }),
  lastScannedAt: timestamp('last_scanned_at', { withTimezone: true }),
  lastLineCount: integer('last_line_count').default(0).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const settings = pgTable('settings', {
  key: varchar('key', { length: 100 }).primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
});
