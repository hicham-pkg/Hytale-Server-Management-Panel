import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { getDb, getPool, schema } from '../db';
import { callHelper } from './helper-client';
import { detectCrashEvents, detectRestartLoop } from '../utils/log-parser';
import type { CrashEvent, CrashEventStatus } from '@hytale-panel/shared';

const { crashEvents, crashScanState } = schema;
const ACTIVE_CRASH_EVENT_WINDOW_MS = 60 * 60 * 1000;
const CRASH_SCAN_LINE_LIMIT = 1000;
const CRASH_SCAN_CURSOR_OVERLAP_MS = 60 * 1000;
const SHORT_ISO_TIMESTAMP_REGEX = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/;
const CRASH_SCAN_STATE_ID = 1;
const CRASH_SCAN_LOCK_KEY = 0x4353434e; // 'CSCN' as ASCII bytes

function getActiveCrashCutoff(now = new Date()): Date {
  return new Date(now.getTime() - ACTIVE_CRASH_EVENT_WINDOW_MS);
}

export function deriveCrashEventStatus(
  event: { detectedAt: Date; archivedAt: Date | null },
  now = new Date()
): CrashEventStatus {
  if (event.archivedAt) {
    return 'archived';
  }

  return event.detectedAt >= getActiveCrashCutoff(now) ? 'active' : 'historical';
}

function mapCrashEvent(event: typeof crashEvents.$inferSelect, now = new Date()): CrashEvent {
  return {
    id: event.id,
    severity: event.severity as CrashEvent['severity'],
    pattern: event.pattern,
    summary: event.summary,
    rawLog: event.rawLog,
    detectedAt: event.detectedAt.toISOString(),
    status: deriveCrashEventStatus(event, now),
    archivedAt: event.archivedAt?.toISOString() ?? null,
    archivedBy: event.archivedBy ?? null,
  };
}

function parseShortIsoTimestamp(line: string): Date | null {
  const match = line.match(SHORT_ISO_TIMESTAMP_REGEX);
  if (!match) return null;
  const parsed = new Date(match[1]);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function computeNextCrashScanCursor(lines: string[]): Date | null {
  let latest: Date | null = null;
  for (const line of lines) {
    const ts = parseShortIsoTimestamp(line);
    if (ts && (!latest || ts.getTime() > latest.getTime())) {
      latest = ts;
    }
  }

  if (!latest) {
    return null;
  }

  const overlapSince = new Date(Math.max(0, latest.getTime() - CRASH_SCAN_CURSOR_OVERLAP_MS));
  return overlapSince;
}

function parsePersistedCursor(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

async function loadPersistedCrashScanCursor(): Promise<Date | null> {
  const db = getDb();
  const [state] = await db
    .select()
    .from(crashScanState)
    .where(eq(crashScanState.id, CRASH_SCAN_STATE_ID))
    .limit(1);

  if (!state) {
    return null;
  }

  return parsePersistedCursor(state.cursorSince);
}

async function persistCrashScanState(cursorSince: Date | null, lastLineCount: number): Promise<void> {
  const db = getDb();
  const now = new Date();
  const normalizedCount = Math.max(0, lastLineCount);

  const [existing] = await db
    .select({ id: crashScanState.id })
    .from(crashScanState)
    .where(eq(crashScanState.id, CRASH_SCAN_STATE_ID))
    .limit(1);

  if (existing) {
    await db
      .update(crashScanState)
      .set({
        cursorSince,
        lastScannedAt: now,
        lastLineCount: normalizedCount,
        updatedAt: now,
      })
      .where(eq(crashScanState.id, CRASH_SCAN_STATE_ID));
    return;
  }

  await db.insert(crashScanState).values({
    id: CRASH_SCAN_STATE_ID,
    cursorSince,
    lastScannedAt: now,
    lastLineCount: normalizedCount,
    updatedAt: now,
  });
}

/**
 * Scan recent logs for crash patterns and store detected events.
 */
export async function scanForCrashes(): Promise<number> {
  const lockClient = await getPool().connect();
  let lockAcquired = false;

  try {
    const lockResult = await lockClient.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [CRASH_SCAN_LOCK_KEY]
    );
    lockAcquired = lockResult.rows[0]?.locked === true;

    if (!lockAcquired) {
      return 0;
    }

    const persistedCursor = await loadPersistedCrashScanCursor();
    const params: { lines: number; since?: string } = { lines: CRASH_SCAN_LINE_LIMIT };
    if (persistedCursor) {
      params.since = persistedCursor.toISOString();
    }

    const result = await callHelper('logs.read', params);
    if (!result.success) {
      await persistCrashScanState(persistedCursor, 0);
      return 0;
    }

    const data = result.data as { lines: string[] };
    const lines = Array.isArray(data.lines) ? data.lines : [];
    const nextCursor = computeNextCrashScanCursor(lines) ?? persistedCursor;
    const events = detectCrashEvents(lines);

    const restartLoop = detectRestartLoop(lines);
    if (restartLoop) events.push(restartLoop);

    let inserted = 0;

    if (events.length > 0) {
      const db = getDb();
      const CRASH_DEDUP_BUCKET_MS = 60 * 60 * 1000;
      const bucketStart = new Date(Math.floor(Date.now() / CRASH_DEDUP_BUCKET_MS) * CRASH_DEDUP_BUCKET_MS);

      for (const event of events) {
        try {
          // Dedup by (pattern, summary, time bucket). rawLog includes surrounding
          // context lines that shift as the log buffer scrolls, so matching on it
          // would let the same underlying crash insert a new row every scan cycle.
          const [recent] = await db
            .select()
            .from(crashEvents)
            .where(
              and(
                eq(crashEvents.pattern, event.pattern),
                eq(crashEvents.summary, event.summary),
                gte(crashEvents.detectedAt, bucketStart)
              )
            )
            .limit(1);

          if (!recent) {
            await db.insert(crashEvents).values({
              severity: event.severity,
              pattern: event.pattern,
              summary: event.summary,
              rawLog: event.rawLog?.slice(0, 5000) ?? null,
            });
            inserted++;
          }
        } catch (err) {
          console.error('Failed to insert crash event:', err);
        }
      }
    }

    await persistCrashScanState(nextCursor ?? null, lines.length);
    return inserted;
  } finally {
    if (lockAcquired) {
      await lockClient.query('SELECT pg_advisory_unlock($1)', [CRASH_SCAN_LOCK_KEY]).catch(() => undefined);
    }
    lockClient.release();
  }
}

/**
 * Query crash events with pagination.
 */
export async function queryCrashEvents(options: {
  page?: number;
  limit?: number;
  status?: CrashEventStatus | 'all';
}): Promise<{ events: CrashEvent[]; total: number }> {
  const db = getDb();
  const now = new Date();
  const page = Math.max(options.page ?? 1, 1);
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const offset = (page - 1) * limit;
  const status = options.status ?? 'all';
  const activeCutoff = getActiveCrashCutoff(now);

  const where =
    status === 'active'
      ? and(isNull(crashEvents.archivedAt), gte(crashEvents.detectedAt, activeCutoff))
      : status === 'historical'
        ? and(isNull(crashEvents.archivedAt), lt(crashEvents.detectedAt, activeCutoff))
        : status === 'archived'
          ? isNotNull(crashEvents.archivedAt)
          : undefined;

  const [events, countResult] = await Promise.all([
    db
      .select()
      .from(crashEvents)
      .where(where)
      .orderBy(desc(crashEvents.detectedAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)` })
      .from(crashEvents)
      .where(where),
  ]);

  return {
    events: events.map((event) => mapCrashEvent(event, now)),
    total: Number(countResult[0]?.count ?? 0),
  };
}

export async function getCrashEvent(id: string): Promise<CrashEvent | null> {
  const db = getDb();
  const now = new Date();
  const [event] = await db
    .select()
    .from(crashEvents)
    .where(sql`${crashEvents.id} = ${id}`)
    .limit(1);

  if (!event) return null;

  return mapCrashEvent(event, now);
}

export async function archiveCrashEvent(
  id: string,
  archivedBy: string
): Promise<{ success: boolean; error?: string; alreadyArchived?: boolean }> {
  const db = getDb();
  const [event] = await db
    .select()
    .from(crashEvents)
    .where(eq(crashEvents.id, id))
    .limit(1);

  if (!event) {
    return { success: false, error: 'Crash event not found' };
  }

  if (event.archivedAt) {
    return { success: true, alreadyArchived: true };
  }

  await db
    .update(crashEvents)
    .set({
      archivedAt: new Date(),
      archivedBy,
    })
    .where(eq(crashEvents.id, id));

  return { success: true };
}

export async function archiveHistoricalCrashEvents(
  archivedBy: string
): Promise<{ success: boolean; archivedCount: number }> {
  const db = getDb();
  const activeCutoff = getActiveCrashCutoff();

  const historicalEvents = await db
    .select({ id: crashEvents.id })
    .from(crashEvents)
    .where(and(isNull(crashEvents.archivedAt), lt(crashEvents.detectedAt, activeCutoff)));

  if (historicalEvents.length === 0) {
    return { success: true, archivedCount: 0 };
  }

  const ids = historicalEvents.map((event) => event.id);

  await db
    .update(crashEvents)
    .set({
      archivedAt: new Date(),
      archivedBy,
    })
    .where(inArray(crashEvents.id, ids));

  return { success: true, archivedCount: ids.length };
}
