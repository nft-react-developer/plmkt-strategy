import { eq } from 'drizzle-orm';
import { getDb } from '../../db/connection';
import { manualEntryQueue } from '../../db/schema';

export async function enqueueMarket(conditionId: string): Promise<void> {
  const db = await getDb();
  await db.insert(manualEntryQueue).values({ conditionId }).onDuplicateKeyUpdate({ set: { conditionId } });
}

export async function dequeueMarket(conditionId: string): Promise<void> {
  const db = await getDb();
  await db.delete(manualEntryQueue).where(eq(manualEntryQueue.conditionId, conditionId));
}

export async function drainQueue(): Promise<string[]> {
  const db = await getDb();
  const rows = await db.select({ conditionId: manualEntryQueue.conditionId }).from(manualEntryQueue);
  return rows.map(r => r.conditionId);
}
