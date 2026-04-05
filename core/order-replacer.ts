// core/order-replacer.ts
//
// Recolocación automática de órdenes cuando el precio se mueve.
//
// Problema que resuelve:
//   El rewards_executor coloca las órdenes al entrar y las deja fijas.
//   Si el midprice se mueve 3¢, tus órdenes quedan fuera del max_spread
//   y dejan de puntuar para los rewards.
//
// Solución:
//   Cada tick, si el midprice se movió más de REPRICE_THRESHOLD_CENTS
//   desde la última colocación:
//     1. Cancelar las órdenes viejas en el CLOB
//     2. Colocar nuevas órdenes al nuevo midprice
//     3. Actualizar la DB
//
// En paper trading: solo simula el reprecio (sin CLOB real).
// En real trading:  cancela y recoloca con el cliente autenticado.

import { cancelOrder, cancelAllForMarket, postOrder } from './clob-client';
import { calcMidprice, calcOrderPrices }              from './rewards-scoring';
import { orderQueries, positionQueries }              from '../db/queries-paper';
import { calcTakerFee, parseCategory }               from '../utils/fees';
import { logger }                                    from '../utils/logger';

// ─── Tipos ───────────────────────────────────────────────────────────────────

export interface RepricerParams {
  repricingThresholdCents: number;  // mover si el mid se fue mas de X¢ (default: 1.5)
  maxRepricesPerHour:      number;  // max reprices por posicion por hora (default: 10)
  paperTrading:            boolean;
}

const DEFAULT_PARAMS: RepricerParams = {
  repricingThresholdCents: 1.5,
  maxRepricesPerHour:      10,
  paperTrading:            true,
};

// Tracking de cuántas veces se reprecio cada posición en la última hora
const repriceCount = new Map<number, { count: number; windowStart: number }>();

// ─── API principal ────────────────────────────────────────────────────────────

export interface RepriceResult {
  action:       'repriced' | 'skipped' | 'error';
  reason?:      string;
  oldMidprice?: number;
  newMidprice?: number;
  newBidOrderId?: string;
  newAskOrderId?: string;
  feesPaid?:    number;
}

/**
 * Evalúa si las órdenes de una posición necesitan recolocarse.
 * Si el midprice se movió más del threshold → cancela y recoloca.
 */
export async function repriceIfNeeded(
  positionId:     number,
  tokenIdYes:     string,
  currentMidprice: number,
  maxSpreadCents:  number,
  sizePerSideUsdc: number,
  dualSideRequired: boolean,
  params: Partial<RepricerParams> = {},
): Promise<RepriceResult> {
  const p = { ...DEFAULT_PARAMS, ...params };

  // Obtener el midprice en el momento de la última colocación
  const pos = await positionQueries.getById(positionId);
  if (!pos) return { action: 'error', reason: 'posicion no encontrada' };

  // Tomar el midprice de entrada como referencia base
  // (en producción podríamos guardar el último midprice de reprecio)
  const lastMidprice = Number(pos.entryMidprice);
  const moveCents    = Math.abs(currentMidprice - lastMidprice) * 100;

  if (moveCents < p.repricingThresholdCents) {
    return { action: 'skipped', reason: `movimiento ${moveCents.toFixed(2)}¢ < umbral ${p.repricingThresholdCents}¢` };
  }

  // Verificar rate limit de reprices
  const now     = Date.now();
  const tracker = repriceCount.get(positionId) ?? { count: 0, windowStart: now };

  if (now - tracker.windowStart > 3_600_000) {
    // Reset ventana de 1 hora
    tracker.count = 0;
    tracker.windowStart = now;
  }

  if (tracker.count >= p.maxRepricesPerHour) {
    return {
      action: 'skipped',
      reason: `rate limit: ${tracker.count}/${p.maxRepricesPerHour} reprices esta hora`,
    };
  }

  logger.info(
    `[order-replacer] Repreciando posicion #${positionId} | ` +
    `mid: ${(lastMidprice * 100).toFixed(1)}¢ → ${(currentMidprice * 100).toFixed(1)}¢ | ` +
    `movimiento: ${moveCents.toFixed(2)}¢`,
  );

  // Calcular nuevas órdenes al midprice actual
  const newOrders = calcOrderPrices(currentMidprice, maxSpreadCents, sizePerSideUsdc, dualSideRequired);

  const category = parseCategory(null);
  const feesPaid = newOrders.reduce((sum, o) => sum + calcTakerFee(o.price, category) * o.sizeUsdc, 0);

  let newBidOrderId: string | undefined;
  let newAskOrderId: string | undefined;

  if (p.paperTrading) {
    // ── PAPER: solo actualizar DB ─────────────────────────────────────────
    logger.info(`[order-replacer] PAPER — simulando reprecio`);

    // Marcar órdenes viejas como canceladas
    const oldOrders = await orderQueries.getForPosition(positionId);
    // En paper solo registramos las nuevas, las viejas quedan como simulated

    // Insertar nuevas órdenes en DB
    await orderQueries.insertMany(
      newOrders.map(o => ({
        positionId,
        paperTrading:       true,
        tokenId:            tokenIdYes,
        side:               o.side,
        price:              o.price,
        sizeUsdc:           o.sizeUsdc,
        sizeShares:         o.sizeShares,
        spreadFromMidCents: o.spreadFromMidCents,
      })),
    );

  } else {
    // ── REAL: cancelar en CLOB y recolocar ────────────────────────────────
    try {
      // 1. Cancelar todas las órdenes del mercado de golpe
      await cancelAllForMarket(tokenIdYes);
      logger.info(`[order-replacer] Ordenes canceladas para token ${tokenIdYes.slice(0, 10)}`);

      // 2. Colocar nuevas órdenes
      for (const o of newOrders) {
        const posted = await postOrder({
          tokenId: tokenIdYes,
          price:   o.price,
          size:    o.sizeShares,
          side:    o.side === 'buy' ? 'BUY' : 'SELL',
        });

        if (o.side === 'buy')  newBidOrderId = posted.orderId;
        if (o.side === 'sell') newAskOrderId = posted.orderId;

        // 3. Actualizar DB con nuevo clob_order_id
        await orderQueries.insertMany([{
          positionId,
          paperTrading:       false,
          tokenId:            tokenIdYes,
          side:               o.side,
          price:              o.price,
          sizeUsdc:           o.sizeUsdc,
          sizeShares:         o.sizeShares,
          spreadFromMidCents: o.spreadFromMidCents,
        }]);
      }

      logger.info(
        `[order-replacer] Nuevas ordenes colocadas | ` +
        `bid: ${newBidOrderId} | ask: ${newAskOrderId}`,
      );

    } catch (err) {
      logger.error('[order-replacer] Error en reprecio real', err);
      return { action: 'error', reason: String(err) };
    }
  }

  // Registrar fee adicional de reprecio
  await positionQueries.addFee(positionId, feesPaid);

  // Actualizar entry_midprice con el nuevo midprice para el próximo reprecio
  // (hack: reusamos el campo entryMidprice como "last repriced at")
  // En producción habría que añadir un campo last_reprice_midprice a la tabla

  // Incrementar counter de reprices
  tracker.count++;
  repriceCount.set(positionId, tracker);

  console.log(
    `[order-replacer] Reprecio #${tracker.count} | ` +
    `${(lastMidprice * 100).toFixed(1)}¢ → ${(currentMidprice * 100).toFixed(1)}¢ | ` +
    `fee: $${feesPaid.toFixed(4)} | ` +
    `${p.paperTrading ? 'PAPER' : 'REAL'}`,
  );

  return {
    action:        'repriced',
    oldMidprice:   lastMidprice,
    newMidprice:   currentMidprice,
    newBidOrderId,
    newAskOrderId,
    feesPaid,
  };
}

/**
 * Reset del tracker de reprices (útil al cerrar una posición).
 */
export function clearRepriceTracker(positionId: number): void {
  repriceCount.delete(positionId);
}

// ---- Re-queue FIFO ----------------------------------------------------------

const requeueTimestamps = new Map<number, number>();

export interface RequeueResult {
  action:  'requeued' | 'skipped' | 'error';
  reason?: string;
}

/**
 * Re-queue FIFO: cancela y repone las ordenes en el MISMO precio
 * para subir al tope de la cola de ejecucion.
 *
 * El CLOB de Polymarket es FIFO — al cancelar y reponer quedas al
 * final de la cola de ese precio, pero si sos el unico en ese tick
 * quedas primero.
 *
 * Solo corre si NO hubo reprecio en este tick (no tiene sentido hacer los dos).
 */
export async function requeueIfNeeded(
  positionId:       number,
  tokenIdYes:       string,
  maxSpreadCents:   number,
  sizePerSideUsdc:  number,
  dualSideRequired: boolean,
  currentMidprice:  number,
  params: {
    requeueIntervalMinutes: number;
    paperTrading:           boolean;
  },
): Promise<RequeueResult> {
  const intervalMs  = params.requeueIntervalMinutes * 60_000;
  const lastRequeue = requeueTimestamps.get(positionId) ?? 0;
  const now         = Date.now();

  if (now - lastRequeue < intervalMs) {
    const nextIn = Math.ceil((lastRequeue + intervalMs - now) / 60_000);
    return { action: 'skipped', reason: `proximo re-queue en ${nextIn}min` };
  }

  logger.info(`[order-replacer] Re-queue FIFO #${positionId} | mid=${(currentMidprice * 100).toFixed(1)}c`);

  const newOrders = calcOrderPrices(currentMidprice, maxSpreadCents, sizePerSideUsdc, dualSideRequired);

  if (params.paperTrading) {
    await orderQueries.insertMany(
      newOrders.map(o => ({
        positionId,
        paperTrading:       true,
        tokenId:            tokenIdYes,
        side:               o.side,
        price:              o.price,
        sizeUsdc:           o.sizeUsdc,
        sizeShares:         o.sizeShares,
        spreadFromMidCents: o.spreadFromMidCents,
      })),
    );
    requeueTimestamps.set(positionId, now);
    const bid = newOrders.find(o => o.side === 'buy');
    const ask = newOrders.find(o => o.side === 'sell');
    console.log(`[order-replacer] Re-queue PAPER #${positionId} | bid=${bid ? (bid.price * 100).toFixed(1) : '?'}c ask=${ask ? (ask.price * 100).toFixed(1) : '?'}c`);
    return { action: 'requeued' };
  }

  try {
    await cancelAllForMarket(tokenIdYes);
    for (const o of newOrders) {
      const posted = await postOrder({
        tokenId: tokenIdYes,
        price:   o.price,
        size:    o.sizeShares,
        side:    o.side === 'buy' ? 'BUY' : 'SELL',
      });
      await orderQueries.insertMany([{
        positionId,
        paperTrading:       false,
        tokenId:            tokenIdYes,
        side:               o.side,
        price:              o.price,
        sizeUsdc:           o.sizeUsdc,
        sizeShares:         o.sizeShares,
        spreadFromMidCents: o.spreadFromMidCents,
      }]);
      logger.info(`[order-replacer] Re-queue REAL ${o.side} @ ${o.price.toFixed(4)} | id: ${posted.orderId}`);
    }
    requeueTimestamps.set(positionId, now);
    console.log(`[order-replacer] Re-queue REAL #${positionId} completado`);
    return { action: 'requeued' };
  } catch (err) {
    logger.error('[order-replacer] Error en re-queue', err);
    return { action: 'error', reason: String(err) };
  }
}

/**
 * Reset del tracker de re-queue (al cerrar una posicion).
 */
export function clearRequeueTracker(positionId: number): void {
  requeueTimestamps.delete(positionId);
}