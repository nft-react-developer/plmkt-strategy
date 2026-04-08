// core/inventory-manager.ts
//
// Gestión de inventario para trading real.
// Monitorea las órdenes activas en el CLOB, detecta cuando se ejecutan (fills),
// calcula la exposición por mercado y decide si cubrir o cerrar.
//
// CAMBIOS (fixes de fill loop):
//
//   FIX 1 — rebalanceIfNeeded deshabilitado para rewards_executor:
//     El hedge de SELL YES cuando te fillean la BUY requiere tener shares en
//     la wallet, lo cual es correcto pero el CLOB rechaza SELL si ya tenés
//     demasiadas órdenes abiertas en ese token. Además el loop se volvía
//     infinito porque cada tick reintentaba el hedge fallido. La estrategia
//     de rewards no necesita hedge activo — si te fillean, el PnL real
//     viene de la resolución del mercado, no del hedge.
//
//   FIX 2 — syncInventory usa clobOrderId real de la DB:
//     Antes comparaba o.id (ID de DB) con el ID de orden del CLOB, lo cual
//     nunca matcheaba (son distintos). Ahora compara o.clobOrderId con el
//     ID de la orden del CLOB real.
//
//   FIX 3 — cooldown de rebalanceo para no spamear el CLOB:
//     Si el rebalanceo falla por balance insuficiente, el cooldown evita
//     reintentar en cada tick hasta que haya capacidad.

import { getOpenOrders, getMyTrades, cancelOrder, postOrder } from './clob-client';
import { orderQueries, positionQueries }                       from '../db/queries-paper';
import { logger }                                             from '../utils/logger';
import { Side } from '@polymarket/clob-client';

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
  hasFills:       boolean;
  // Órdenes activas en el CLOB en este momento (fuente de verdad para precios reales)
  liveOrders:     { id: string; side: string; price: number; size: number }[];
}

export interface InventoryManagerParams {
  maxExposureShares:     number;   // exposición máxima en shares antes de cubrir (default: 50)
  hedgeThresholdShares:  number;   // shares para disparar cobertura (default: 25)
  maxInventoryValueUsdc: number;   // valor máximo de inventario en USDC (default: 100)
}

const DEFAULT_PARAMS: InventoryManagerParams = {
  maxExposureShares:     50,
  hedgeThresholdShares:  25,
  maxInventoryValueUsdc: 100,
};

// ─── Estado en memoria ────────────────────────────────────────────────────────
const inventoryState = new Map<string, InventoryState>();

// FIX: cooldown de rebalanceo por posición para no spamear cuando falla por balance.
// Clave: positionId → timestamp del último intento fallido.
const rebalanceCooldown = new Map<number, number>();
const REBALANCE_COOLDOWN_MS = 5 * 60_000; // 5 minutos entre reintentos

// Tracking de órdenes LIMIT SELL de break-even activas para no re-postear cada tick.
// Clave: tokenId → { orderId, price, size }
const breakEvenHedgeOrders = new Map<string, { orderId: string; price: number; size: number }>();

// ─── API principal ────────────────────────────────────────────────────────────

/**
 * Sincroniza el estado del inventario con el CLOB real.
 * Detecta órdenes ejecutadas y actualiza la exposición.
 *
 * FIX: ahora usa clobOrderId de la DB para comparar con las órdenes del CLOB,
 * en lugar del ID de DB que es completamente distinto al ID del CLOB.
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
  const hasFills      = trades.length > 0;

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
    hasFills,
    liveOrders: openOrders
      .filter((o: any) => o.status === 'LIVE')
      .map((o: any) => ({
        id:    String(o.id),
        side:  String(o.side),
        price: Number(o.price),
        size:  Number(o.size ?? o.original_size ?? 0),
      })),
  };

  inventoryState.set(tokenIdYes, state);

  logger.debug(
    `[inventory] token ${tokenIdYes.slice(0, 10)} | ` +
    `long=${sharesLong.toFixed(2)} short=${sharesShort.toFixed(2)} net=${netExposure.toFixed(2)} | ` +
    `avgEntry=${avgEntryPrice.toFixed(4)} mid=${currentMidprice.toFixed(4)} | ` +
    `uPnL=${unrealizedPnl >= 0 ? '+' : ''}$${unrealizedPnl.toFixed(4)}`,
  );

  // FIX: detectar fills en órdenes de DB usando clobOrderId (no el ID de DB).
  // Antes comparaba dbOrder.id con clobOrder.id — siempre fallaba.
  const dbOrders = await orderQueries.getOpenForPosition(positionId);
  for (const dbOrder of dbOrders) {
    if (!dbOrder.clobOrderId) continue; // sin clobOrderId no podemos comparar

    const clobOrder = openOrders.find((o: any) => o.id === dbOrder.clobOrderId);
    if (!clobOrder) {
      // La orden ya no está en el CLOB → fue ejecutada o cancelada
      const isFilled = trades.some((t: any) =>
        t.order_id === dbOrder.clobOrderId || t.maker_order_id === dbOrder.clobOrderId,
      );
      const newStatus = isFilled ? 'filled' : 'cancelled';
      logger.info(`[inventory] orden #${dbOrder.id} (${dbOrder.clobOrderId?.slice(0, 12)}…) → ${newStatus}`);
      await orderQueries.updateStatusByClobId(dbOrder.clobOrderId, newStatus).catch(() => {});
    }
  }

  // Alerta de riesgo de inventario
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
 *
 * FIX: Esta función ahora está DESHABILITADA para la estrategia de rewards.
 * El motivo: cuando te fillean una BUY YES, el hedge SELL YES requiere tokens
 * que tal vez no tenés disponibles (ya comprometidos en otras órdenes), y el
 * loop infinito de reintentos spamea el CLOB y genera errores 400 continuos.
 *
 * La estrategia de rewards no necesita hedge activo:
 *   - Si te fillean la BUY YES → tenés shares que se resuelven con el mercado
 *   - Si te fillean la BUY NO → idem con NO
 *   - El PnL viene de la resolución, no del spread
 *
 * Si en el futuro querés reactivar el rebalanceo, necesitás:
 *   1. Verificar balance disponible antes de postear
 *   2. Usar el cooldown de rebalanceCooldown para no reintentar en cada tick
 *   3. Cancelar órdenes activas antes de intentar el hedge (libera balance)
 */
export async function rebalanceIfNeeded(
  state:          InventoryState,
  midprice:       number,
  maxSpreadCents: number,
  params:         Partial<InventoryManagerParams> = {},
): Promise<'rebalanced' | 'ok' | 'error'> {
  // FIX: deshabilitado — ver comentario de la función.
  logger.debug(`[inventory] rebalanceIfNeeded deshabilitado para rewards_executor`);
  return 'ok';
}

/**
 * Cuando hay exposición neta larga (fills de BUY sin cubrir), coloca una
 * LIMIT SELL al precio de break-even (avgEntryPrice).
 *
 * Ventajas respecto a cierre a mercado:
 *   - Cobrar maker rebate en vez de pagar taker fee
 *   - La posición sigue abierta → se continúa haciendo LP con BID + ASK
 *
 * Internamente trackea la orden con breakEvenHedgeOrders para no re-postear
 * en cada tick. Cuando netExposure vuelve a 0 (el SELL se ejecutó),
 * limpia el tracking automáticamente.
 */
export async function rebalanceWithBreakEvenHedge(
  state: InventoryState,
): Promise<'hedged' | 'already_hedged' | 'ok' | 'error'> {
  // Si la exposición neta es cero, el hedge ya fue ejecutado → limpiar tracking
  if (state.netExposure < 0.01) {
    breakEvenHedgeOrders.delete(state.tokenId);
    return 'ok';
  }

  // Si ya tenemos una orden de break-even activa, no re-postear
  const existing = breakEvenHedgeOrders.get(state.tokenId);
  if (existing) {
    logger.debug(
      `[inventory] break-even hedge activo | ` +
      `orderId: ${existing.orderId.slice(0, 12)}… | ` +
      `SELL ${existing.size.toFixed(2)} @ ${existing.price.toFixed(4)}`,
    );
    return 'already_hedged';
  }

  try {
    logger.info(
      `[inventory] Colocando LIMIT SELL break-even | ` +
      `SELL ${state.netExposure.toFixed(2)} @ ${state.avgEntryPrice.toFixed(4)} | ` +
      `(cobrar maker rebate en vez de pagar taker fee)`,
    );

    const posted = await postOrder({
      tokenId: state.tokenId,
      price:   state.avgEntryPrice,
      size:    state.netExposure,
      side:    Side.SELL,
    });

    breakEvenHedgeOrders.set(state.tokenId, {
      orderId: posted.orderId,
      price:   state.avgEntryPrice,
      size:    state.netExposure,
    });

    logger.info(
      `[inventory] Break-even hedge colocado | id: ${posted.orderId} | ` +
      `SELL ${state.netExposure.toFixed(2)} @ ${state.avgEntryPrice.toFixed(4)}`,
    );

    return 'hedged';
  } catch (err) {
    logger.error('[inventory] Error colocando break-even hedge', err);
    return 'error';
  }
}

/**
 * Limpia el tracking del break-even hedge (llamar al cerrar posición).
 */
export function clearBreakEvenHedge(tokenId: string): void {
  breakEvenHedgeOrders.delete(tokenId);
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

  // 2. Liquidar exposición neta (solo si es significativa)
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
      side:    Side.SELL,
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
      side:    Side.BUY,
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
  totalPositions:     number;
  totalNetExposure:   number;
  totalUnrealizedPnl: number;
  positions:          InventoryState[];
} {
  const positions = Array.from(inventoryState.values());
  return {
    totalPositions:     positions.length,
    totalNetExposure:   positions.reduce((s, p) => s + Math.abs(p.netExposure), 0),
    totalUnrealizedPnl: positions.reduce((s, p) => s + p.unrealizedPnl, 0),
    positions,
  };
}