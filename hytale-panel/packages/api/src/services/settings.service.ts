import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db';

const { settings } = schema;

export async function getSetting(key: string): Promise<unknown | null> {
  const db = getDb();
  const [row] = await db.select().from(settings).where(eq(settings.key, key)).limit(1);
  return row?.value ?? null;
}

export async function getAllSettings(): Promise<Record<string, unknown>> {
  const db = getDb();
  const rows = await db.select().from(settings);
  const result: Record<string, unknown> = {};
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return result;
}

export async function updateSetting(
  key: string,
  value: unknown,
  userId: string
): Promise<void> {
  const db = getDb();
  const existing = await db.select().from(settings).where(eq(settings.key, key)).limit(1);

  if (existing.length > 0) {
    await db
      .update(settings)
      .set({ value: value as Record<string, unknown>, updatedAt: new Date(), updatedBy: userId })
      .where(eq(settings.key, key));
  } else {
    await db.insert(settings).values({
      key,
      value: value as Record<string, unknown>,
      updatedBy: userId,
    });
  }
}

export async function updateSettings(
  updates: Record<string, unknown>,
  userId: string
): Promise<void> {
  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      await updateSetting(key, value, userId);
    }
  }
}