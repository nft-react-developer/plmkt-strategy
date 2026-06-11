import 'dotenv/config';
import { Chain, ClobClient } from '@polymarket/clob-client-v2';
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

  const client = new ClobClient({
    host: 'https://clob.polymarket.com',
    chain: Chain.POLYGON,
    signer: wallet as any,
    creds: { key: apiKey, secret, passphrase },
    signatureType: sigType,
    funderAddress: funder,
  });

  try {
    const orders = await client.getOpenOrders();
    console.log('✅ Auth OK — órdenes abiertas:', orders?.length ?? 0);
  } catch (err) {
    console.error('❌ Auth fallida:', err instanceof Error ? err.message : err);
  }
}

main();