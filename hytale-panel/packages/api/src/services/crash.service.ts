import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { getDb, schema } from '../db';
import { callHelper } from './helper-client';
import { detectCrashEvents, detectRestartLoop } from '../utils/log-parser';
import type { CrashEvent, CrashEventStatus } from '@hytale-panel/shared';

const { crashEvents } = schema;
const ACTIVE_CRASH_EVENT_WINDOW_MS = 60 * 60 * 1000;

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

/**
 * Scan recent logs for crash patterns and store detected events.
 */
export async function scanForCrashes(): Promise<number> {
  const result = await callHelper('logs.read', { lines: 500 });
  if (!result.success) return 0;

  const data = result.data as { lines: string[] };
  const events = detectCrashEvents(data.lines);

  const restartLoop = detectRestartLoop(data.lines);
  if (restartLoop) events.push(restartLoop);

  if (events.length === 0) return 0;

  const db = getDb();
  let inserted = 0;

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

  return inserted;
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
