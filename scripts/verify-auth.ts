import 'dotenv/config';
import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';

async function main() {
  const wallet     = new Wallet(process.env.PRIVATE_KEY!);
  const funder     = process.env.POLY_FUNDER!;
  const sigType    = Number(process.env.POLY_SIGNATURE_TYPE ?? 1);
  const apiKey     = process.env.POLY_API_KEY!;
  const secret     = process.env.POLY_API_SECRET!;
  const passphrase = process.env.POLY_API_PASSPHRASE!;

  console.log('wallet:  ', wallet.address);
  console.log('funder:  ', funder);
  console.log('sigType: ', sigType);
  console.log('apiKey:  ', apiKey?.slice(0, 8) + '...');

  const client = new ClobClient(
    'https://clob.polymarket.com',
    137,
    wallet as any,
    { key: apiKey, secret, passphrase },
    sigType,
    funder,
  );

  try {
    const orders = await client.getOpenOrders();
    console.log('✅ Auth OK — órdenes abiertas:', orders?.length ?? 0);
  } catch (err) {
    console.error('❌ Auth fallida:', err instanceof Error ? err.message : err);
  }
}

main();