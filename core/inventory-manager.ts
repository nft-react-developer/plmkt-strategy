// core/inventory-manager.ts
//
// Gestión de inventario para trading real.
// Monitorea las órdenes activas en el CLOB, detecta cuando se ejecutan (fills),
// calcula la exposición por mercado y decide si cubrir o cerrar.
//
// Conceptos clave:
//   - Cuando colocás un bid (BUY) y te lo ejecutan → tenés shares de YES
//   - Cuando colocás un ask (SELL) y te lo ejecutan → vendiste shares de YES
//   - La exposición neta = shares compradas - shares vendidas
//   - Si la exposición supera el umbral → el bot reequilibra
//
// Este módulo se integra con el rewards_executor cuando paperTrading = false.

import { getOpenOrders, getMyTrades, cancelOrder, postOrder } from './clob-client';
import { orderQueries, positionQueries }                       from '../db/queries-paper';
import { calcTakerFee, parseCategory }                        from '../utils/fees';
import { logger }                                             from '../utils/logger';

// ─── Tipos ───────────────────────────────────────────────────────────────────

export interface InventoryState {
  tokenId:        string;
  positionId:     number;
  sharesLong:     number;   // shares compradas (BUY ejecutadas)
  sharesShort:    number;   // shares vendidas (SELL ejecutadas)
  netExposure:    number;   // sharesLong - sharesShort
  avgEntryPrice:  number;   // precio promedio de entrada
  unrealizedPnl:  number;   // estimado al precio actual
  openBidOrderId: string | null;
  openAskOrderId: string | null;
}

export interface InventoryManagerParams {
  maxExposureShares:    number;   // exposición máxima en shares antes de cubrir (default: 50)
  hedgeThresholdShares: number;   // shares para disparar cobertura (default: 25)
  maxInventoryValueUsdc: number;  // valor máximo de inventario en USDC (default: 100)
}

const DEFAULT_PARAMS: InventoryManagerParams = {
  maxExposureShares:     50,
  hedgeThresholdShares:  25,
  maxInventoryValueUsdc: 100,
};

// ─── Estado en memoria ────────────────────────────────────────────────────────
// Mapa de tokenId → estado de inventario para posiciones abiertas
const inventoryState = new Map<string, InventoryState>();

// ─── API principal ────────────────────────────────────────────────────────────

/**
 * Sincroniza el estado del inventario con el CLOB real.
 * Detecta órdenes ejecutadas y actualiza la exposición.
 * Llama a esto cada minuto junto con el tick del rewards_executor.
 */
export async function syncInventory(
  positionId: number,
  tokenIdYes: string,
  tokenIdNo:  string | null | undefined,
  currentMidprice: number,
  params: Partial<InventoryManagerParams> = {},
): Promise<InventoryState> {
  const p = { ...DEFAULT_PARAMS, ...params };

  // Obtener órdenes abiertas actuales en el CLOB
  const openOrders = await getOpenOrders(tokenIdYes);
  const openBid    = openOrders.find((o: any) => o.side === 'BUY'  && o.status === 'LIVE');
  const openAsk    = openOrders.find((o: any) => o.side === 'SELL' && o.status === 'LIVE');

  // Obtener trades ejecutados para este token
  const trades = await getMyTrades(tokenIdYes);

  // Calcular exposición acumulada de todos los fills
  let sharesLong  = 0;
  let sharesShort = 0;
  let totalCost   = 0;
  let totalSold   = 0;

  for (const trade of trades) {
    const size  = Number(trade.size  ?? trade.matched_amount ?? 0);
    const price = Number(trade.price ?? trade.last_price     ?? 0);

    if (trade.side === 'BUY') {
      sharesLong += size;
      totalCost  += size * price;
    } else {
      sharesShort += size;
      totalSold   += size * price;
    }
  }

  const netExposure   = sharesLong - sharesShort;
  const avgEntryPrice = sharesLong > 0 ? totalCost / sharesLong : 0;
  const unrealizedPnl = netExposure * (currentMidprice - avgEntryPrice);

  const state: InventoryState = {
    tokenId:        tokenIdYes,
    positionId,
    sharesLong,
    sharesShort,
    netExposure,
    avgEntryPrice,
    unrealizedPnl,
    openBidOrderId: openBid?.id ?? null,
    openAskOrderId: openAsk?.id ?? null,
  };

  inventoryState.set(tokenIdYes, state);

  logger.debug(
    `[inventory] token ${tokenIdYes.slice(0, 10)} | ` +
    `long=${sharesLong.toFixed(2)} short=${sharesShort.toFixed(2)} net=${netExposure.toFixed(2)} | ` +
    `avgEntry=${avgEntryPrice.toFixed(4)} mid=${currentMidprice.toFixed(4)} | ` +
    `uPnL=${unrealizedPnl >= 0 ? '+' : ''}$${unrealizedPnl.toFixed(4)}`,
  );

  // Actualizar órdenes abiertas en DB
  if (openBid || openAsk) {
    const posOrders = await orderQueries.getForPosition(positionId);
    for (const dbOrder of posOrders) {
      const clobOrder = openOrders.find((o: any) => o.id === dbOrder.clobOrderId);
      if (!clobOrder && dbOrder.status === 'open') {
        // Orden ya no está en el CLOB → fue ejecutada o cancelada
        const isFilled = trades.some((t: any) => t.order_id === dbOrder.clobOrderId);
        const newStatus = isFilled ? 'filled' : 'cancelled';
        logger.info(`[inventory] orden #${dbOrder.id} (${dbOrder.clobOrderId}) → ${newStatus}`);
        // Nota: actualizar status en DB requeriría un nuevo query — simplificado aquí
      }
    }
  }

  // ── Alertas de riesgo ─────────────────────────────────────────────────────
  const inventoryValueUsdc = Math.abs(netExposure) * currentMidprice;

  if (inventoryValueUsdc > p.maxInventoryValueUsdc) {
    logger.warn(
      `[inventory] ALERTA: inventario $${inventoryValueUsdc.toFixed(2)} > max $${p.maxInventoryValueUsdc}`,
    );
  }

  return state;
}

/**
 * Evalúa si hay que reequilibrar el inventario.
 * Se llama después de syncInventory si la exposición supera el umbral.
 *
 * Estrategia de cobertura:
 *   - Si tenés muchas shares de YES (long): colocar más asks para reducir
 *   - Si vendiste muchas shares de YES (short): colocar más bids para cubrir
 */
export async function rebalanceIfNeeded(
  state:        InventoryState,
  midprice:     number,
  maxSpreadCents: number,
  params:       Partial<InventoryManagerParams> = {},
): Promise<'rebalanced' | 'ok' | 'error'> {
  const p = { ...DEFAULT_PARAMS, ...params };

  if (Math.abs(state.netExposure) < p.hedgeThresholdShares) {
    return 'ok';
  }

  logger.info(
    `[inventory] Reequilibrando: net=${state.netExposure.toFixed(2)} shares | ` +
    `umbral=${p.hedgeThresholdShares}`,
  );

  try {
    const targetSpread = Math.min(1.0, maxSpreadCents - 0.5) / 100;

    if (state.netExposure > p.hedgeThresholdShares) {
      // Demasiadas shares de YES → colocar asks adicionales
      const askPrice = Math.min(0.99, midprice + targetSpread);
      const hedgeSize = Math.min(state.netExposure - p.hedgeThresholdShares, p.maxExposureShares);

      logger.info(`[inventory] Hedge SELL ${hedgeSize.toFixed(2)} shares @ ${askPrice.toFixed(4)}`);
      await postOrder({
        tokenId: state.tokenId,
        price:   askPrice,
        size:    hedgeSize,
        side:    'SELL',
      });

    } else if (state.netExposure < -p.hedgeThresholdShares) {
      // Demasiadas shares vendidas → colocar bids adicionales
      const bidPrice = Math.max(0.01, midprice - targetSpread);
      const hedgeSize = Math.min(Math.abs(state.netExposure) - p.hedgeThresholdShares, p.maxExposureShares);

      logger.info(`[inventory] Hedge BUY ${hedgeSize.toFixed(2)} shares @ ${bidPrice.toFixed(4)}`);
      await postOrder({
        tokenId: state.tokenId,
        price:   bidPrice,
        size:    hedgeSize,
        side:    'BUY',
      });
    }

    return 'rebalanced';
  } catch (err) {
    logger.error('[inventory] Error en rebalanceo', err);
    return 'error';
  }
}

/**
 * Cierra toda la posición de inventario.
 * Cancela órdenes abiertas y coloca orden de liquidación al mercado.
 */
export async function closeInventoryPosition(
  state:    InventoryState,
  midprice: number,
): Promise<void> {
  logger.info(`[inventory] Cerrando posición — net: ${state.netExposure.toFixed(2)} shares`);

  // 1. Cancelar órdenes abiertas
  if (state.openBidOrderId) {
    await cancelOrder(state.openBidOrderId).catch(err =>
      logger.error(`[inventory] Error cancelando bid ${state.openBidOrderId}`, err),
    );
  }
  if (state.openAskOrderId) {
    await cancelOrder(state.openAskOrderId).catch(err =>
      logger.error(`[inventory] Error cancelando ask ${state.openAskOrderId}`, err),
    );
  }

  // 2. Liquidar exposición neta
  if (Math.abs(state.netExposure) < 0.01) {
    logger.info('[inventory] Sin exposicion neta, solo se cancelaron las ordenes');
    return;
  }

  // Precio agresivo para garantizar ejecución (1¢ mejor que midprice)
  if (state.netExposure > 0) {
    // Tenemos shares de YES → vender
    const liquidationPrice = Math.max(0.01, midprice - 0.01);
    logger.info(`[inventory] Liquidacion SELL ${state.netExposure.toFixed(2)} @ ${liquidationPrice.toFixed(4)}`);
    await postOrder({
      tokenId: state.tokenId,
      price:   liquidationPrice,
      size:    state.netExposure,
      side:    'SELL',
    }).catch(err => logger.error('[inventory] Error en liquidacion', err));
  } else {
    // Vendimos shares que no teníamos → comprar para cubrir
    const liquidationPrice = Math.min(0.99, midprice + 0.01);
    const coverSize = Math.abs(state.netExposure);
    logger.info(`[inventory] Cobertura BUY ${coverSize.toFixed(2)} @ ${liquidationPrice.toFixed(4)}`);
    await postOrder({
      tokenId: state.tokenId,
      price:   liquidationPrice,
      size:    coverSize,
      side:    'BUY',
    }).catch(err => logger.error('[inventory] Error en cobertura', err));
  }

  inventoryState.delete(state.tokenId);
}

/**
 * Devuelve el estado de inventario de un token (si existe).
 */
export function getInventoryState(tokenId: string): InventoryState | null {
  return inventoryState.get(tokenId) ?? null;
}

/**
 * Resumen de todo el inventario activo (para logs y Telegram).
 */
export function getInventorySummary(): {
  totalPositions:    number;
  totalNetExposure:  number;
  totalUnrealizedPnl: number;
  positions: InventoryState[];
} {
  const positions = Array.from(inventoryState.values());
  return {
    totalPositions:     positions.length,
    totalNetExposure:   positions.reduce((s, p) => s + Math.abs(p.netExposure), 0),
    totalUnrealizedPnl: positions.reduce((s, p) => s + p.unrealizedPnl, 0),
    positions,
  };
}