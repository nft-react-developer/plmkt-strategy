/**
 * core/cooldown.ts
 *
 * Cooldown persistido en DB para evitar signals duplicados.
 * Usa la tabla signal_cooldowns para sobrevivir reinicios del proceso.
 *
 * Uso:
 *   const cd = new CooldownManager('odds_mover');
 *   if (await cd.isReady('marketId:tokenId')) {
 *     // emitir signal
 *     await cd.stamp('marketId:tokenId');
 *   }
 */

import { getDb } from '../db/connection';
import { sql } from 'drizzle-orm';

export class CooldownManager {
  private strategyId: string;
  /** Cache en memoria para no ir a DB en cada tick */
  private cache = new Map<string, number>();

  constructor(strategyId: string) {
    this.strategyId = strategyId;
  }

  /**
   * Devuelve true si la key ya pasó el cooldown y se puede emitir signal.
   * @param key       Identificador único del signal (ej. "marketId:tokenId")
   * @param cooldownMs Milisegundos de cooldown (default 1h)
   */
  async isReady(key: string, cooldownMs = 3_600_000): Promise<boolean> {
    // 1. Revisar cache en memoria primero (evita hit a DB en cada tick)
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached < cooldownMs) return false;

    // 2. Consultar DB
    const db = await getDb();
    const rows = await db.execute(
      sql`SELECT last_fired_at FROM signal_cooldowns
          WHERE strategy_id = ${this.strategyId} AND cooldown_key = ${key}
          LIMIT 1`,
    ) as Array<{ last_fired_at: Date }>;

    if (!rows.length) return true;

    const lastFired = new Date(rows[0].last_fired_at).getTime();
    const ready     = Date.now() - lastFired >= cooldownMs;

    // Actualizar cache
    if (!ready) this.cache.set(key, lastFired);
    return ready;
  }

  /**
   * Registra que se emitió un signal para esta key ahora.
   */
  async stamp(key: string): Promise<void> {
    const now = new Date();
    this.cache.set(key, now.getTime());

    const db = await getDb();
    await db.execute(
      sql`INSERT INTO signal_cooldowns (strategy_id, cooldown_key, last_fired_at)
          VALUES (${this.strategyId}, ${key}, ${now})
          ON DUPLICATE KEY UPDATE last_fired_at = ${now}`,
    );
  }

  /** Limpia entradas viejas de la DB (llamar ocasionalmente) */
  async cleanup(olderThanMs = 7 * 86_400_000): Promise<void> {
    const cutoff = new Date(Date.now() - olderThanMs);
    const db     = await getDb();
    await db.execute(
      sql`DELETE FROM signal_cooldowns
          WHERE strategy_id = ${this.strategyId} AND last_fired_at < ${cutoff}`,
    );
  }
}