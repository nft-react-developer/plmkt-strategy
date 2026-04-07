// core/clob-client.ts
//
// Cliente autenticado para el CLOB de Polymarket.
// Wrapper sobre @polymarket/clob-client con manejo de errores,
// logging y soporte para paper/real trading.
//
// Variables de entorno requeridas para trading real:
//   PRIVATE_KEY          — private key de tu wallet Phantom (0x...)
//   POLY_API_KEY         — generada con scripts/generate-api-keys.ts
//   POLY_API_SECRET      — generada con scripts/generate-api-keys.ts
//   POLY_API_PASSPHRASE  — generada con scripts/generate-api-keys.ts
//   POLY_FUNDER          
//   POLY_SIGNATURE_TYPE  — 2 (GNOSIS_SAFE)
import * as dotenv from 'dotenv';
dotenv.config();
import { ClobClient, Side } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';
import { logger }            from '../utils/logger';

const CLOB_BASE        = process.env.CLOB_API_BASE ?? 'https://clob.polymarket.com';
const POLYGON_CHAIN_ID = 137;

// ─── Singleton ────────────────────────────────────────────────────────────────

let _client: ClobClient | null = null;

export function getClobClient(): ClobClient {
  if (_client) return _client;

  const privateKey    = process.env.PRIVATE_KEY;
  const apiKey        = process.env.POLY_API_KEY;
  const secret        = process.env.POLY_API_SECRET;
  const passphrase    = process.env.POLY_API_PASSPHRASE;
  const funder        = process.env.POLY_FUNDER;
  const sigType       = Number(process.env.POLY_SIGNATURE_TYPE ?? 2);

const w = new Wallet(process.env.PRIVATE_KEY!);
console.log('wallet.address:', w.address);
console.log('POLY_FUNDER:', process.env.POLY_FUNDER);
console.log('POLY_SIGNATURE_TYPE:', process.env.POLY_SIGNATURE_TYPE);

  if (!privateKey) throw new Error('PRIVATE_KEY no configurada en .env');
  if (!apiKey || !secret || !passphrase) {
    throw new Error('Faltan POLY_API_KEY / POLY_API_SECRET / POLY_API_PASSPHRASE. Corre scripts/generate-api-keys.ts');
  }

  const wallet = new Wallet(privateKey);
  logger.info(`[clob-client] Inicializando — wallet: ${wallet.address} | funder: ${funder} | sigType: ${sigType}`);

  _client = new ClobClient(
    CLOB_BASE,
    POLYGON_CHAIN_ID,
    wallet as any,
    { key: apiKey, secret, passphrase },
    sigType,
    funder,
  );

  return _client;
}

// ─── Ordenes ─────────────────────────────────────────────────────────────────

export interface OrderParams {
  tokenId:  string;
  price:    number;   // 0.01 – 0.99
  size:     number;   // en shares
  side:     Side;
  tickSize?: '0.1' | '0.01' | '0.001' | '0.0001';  // default '0.01'
  negRisk?:  boolean;
}

export interface PostedOrder {
  orderId:   string;
  status:    string;
  tokenId:   string;
  price:     number;
  size:      number;
  side:      Side;
}

/**
 * Coloca una orden límite en el CLOB.
 * Firma el payload con la private key y la envía con L2 headers.
 */
export async function postOrder(params: OrderParams): Promise<PostedOrder> {
  const client = getClobClient();
  const tickSize = params.tickSize ?? '0.01';
  const negRisk  = params.negRisk  ?? false;

  logger.info(
    `[clob-client] POST order — ${params.side} ${params.size} shares @ ${params.price}` +
    ` | token: ${params.tokenId.slice(0, 10)}...`,
  );

 const result = await client.createAndPostOrder(
    { tokenID: params.tokenId, price: params.price, size: params.size, side: params.side },
    { tickSize, negRisk },
  );

  // ← AÑADIR ESTO: detectar error 400 explícitamente
  const status = (result as any).status;
  if (status === 400 || (result as any).error) {
    const errorMsg = (result as any).error ?? (result as any).message ?? JSON.stringify(result);
    throw new Error(`CLOB rejected order (${status}): ${errorMsg}`);
  }

  const orderId = (result as any).orderID ?? (result as any).id ?? 'unknown';
  const statusLabel = (result as any).status ?? 'posted';

  logger.info(`[clob-client] Orden colocada — id: ${orderId} | status: ${statusLabel}`);

  return { orderId, status: statusLabel, tokenId: params.tokenId, price: params.price, size: params.size, side: params.side };
}

/**
 * Cancela una orden por ID.
 */
export async function cancelOrder(orderId: string): Promise<void> {
  const client = getClobClient();
  logger.info(`[clob-client] Cancelando orden ${orderId}`);
  await client.cancelOrder({ orderID: orderId });
  logger.info(`[clob-client] Orden ${orderId} cancelada`);
}

/**
 * Cancela todas las ordenes de un mercado (token).
 */
export async function cancelAllForMarket(tokenId: string): Promise<void> {
  const client = getClobClient();
  logger.info(`[clob-client] Cancelando todas las ordenes para token ${tokenId.slice(0, 10)}...`);
  await client.cancelMarketOrders({ asset_id: tokenId });
  logger.info(`[clob-client] Ordenes canceladas para token ${tokenId.slice(0, 10)}...`);
}

/**
 * Obtiene las ordenes abiertas del usuario.
 * Si se pasa tokenId, filtra por ese mercado.
 */
export async function getOpenOrders(tokenId?: string): Promise<any[]> {
  const client = getClobClient();
  const params = tokenId ? { asset_id: tokenId } : {};
  const orders = await client.getOpenOrders(params as any);
  return orders ?? [];
}

/**
 * Obtiene los trades ejecutados del usuario.
 */
export async function getMyTrades(tokenId?: string): Promise<any[]> {
  const client = getClobClient();
  const params = tokenId ? { asset_id: tokenId } : {};
  const trades = await client.getTrades(params as any);
  return trades ?? [];
}

/**
 * Verifica que las credenciales son válidas.
 * Útil para hacer un health check al arrancar.
 */
export async function verifyAuth(): Promise<boolean> {
  try {
    const client = getClobClient();
    await client.getOpenOrders();
    logger.info('[clob-client] Auth verificada correctamente');
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[clob-client] Auth fallida: ${msg}`);
    return false;
  }
}