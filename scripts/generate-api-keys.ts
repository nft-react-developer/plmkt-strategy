// scripts/generate-api-keys.ts
//
// Genera las API keys del CLOB de Polymarket usando L1 auth.
// Solo necesitas correr esto UNA VEZ. Guarda las credenciales en tu .env.
//
// Instalacion:
//   yarn add @polymarket/clob-client @ethersproject/wallet viem
//
// Uso:
//   PRIVATE_KEY=0x... ts-node scripts/generate-api-keys.ts
//
// La private key es la de tu wallet Phantom exportada:
//   Phantom → Settings → Security & Privacy → Export Private Key
//
// NUNCA compartas ni commitees tu private key.

import * as dotenv from 'dotenv';
dotenv.config();
import { ApiKeyCreds, ClobClient } from '@polymarket/clob-client';
import { Wallet }    from '@ethersproject/wallet';

const CLOB_BASE        = 'https://clob.polymarket.com';
const POLYGON_CHAIN_ID = 137;
const FUNDER       = process.env.POLY_FUNDER!; // Opcional: dirección de tu wallet (puede derivarse de la private key, pero la ponemos explícita para evitar confusiones)
const SIGNATURE_TYPE       = Number(process.env.POLY_SIGNATURE_TYPE ?? 1);

async function main() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    console.error('ERROR: falta PRIVATE_KEY en el entorno');
    console.error('Uso: PRIVATE_KEY=0x... ts-node scripts/generate-api-keys.ts');
    process.exit(1);
  }

  let signer: Wallet;
  try {
    signer = new Wallet(privateKey);
    console.log(`\n[generate-api-keys] Wallet: ${signer.address}`);
    console.log(`[generate-api-keys] Funder: ${FUNDER}`);
    console.log(`[generate-api-keys] SignatureType: ${SIGNATURE_TYPE}\n`);
  } catch (err) {
    console.log('ERROR: private key invalida. Debe ser hex (0x...)', err);
    process.exit(1);
  }

  // Paso 1: cliente temporal sin creds para derivar las API keys
  const tempClient = new ClobClient(CLOB_BASE, POLYGON_CHAIN_ID, signer as any);

  console.log('[generate-api-keys] Derivando credenciales (firma EIP-712)...');

  let creds: ApiKeyCreds;
  try {
    creds = await tempClient.createOrDeriveApiKey();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('ERROR al derivar credenciales:', msg);
    console.error('\nPosibles causas:');
    console.error('  - La private key no corresponde a la wallet exportada de Phantom');
    console.error('  - La wallet nunca se logueo en polymarket.com');
    process.exit(1);
  }

  console.log('\n✅ Credenciales generadas\n');
  console.log('─'.repeat(60));
  console.log('Añade estas variables a tu .env:\n');
  console.log(`POLY_API_KEY=${creds.key}`);
  console.log(`POLY_API_SECRET=${creds.secret}`);
  console.log(`POLY_API_PASSPHRASE=${creds.passphrase}`);
  console.log(`POLY_FUNDER=${FUNDER}`);
  console.log(`POLY_SIGNATURE_TYPE=${SIGNATURE_TYPE}`);
  console.log('─'.repeat(60));
  console.log('\n⚠️  NUNCA compartas ni commitees estas credenciales.');
  console.log('⚠️  Verificá que .env está en tu .gitignore.\n');

  // Paso 2: verificar que funcionan
  // Nota: las credenciales pueden tardar hasta 2 minutos en activarse
  console.log('[generate-api-keys] Verificando credenciales (puede tardar hasta 2 min)...');

  const client = new ClobClient(
    CLOB_BASE,
    POLYGON_CHAIN_ID,
    signer as any,
    { key: creds.key, secret: creds.secret, passphrase: creds.passphrase },
    SIGNATURE_TYPE,
    FUNDER,
  );

  // Reintentar hasta 6 veces con 20s de espera
  for (let i = 1; i <= 6; i++) {
    try {
      const orders = await client.getOpenOrders();
      console.log(`✅ Verificacion exitosa. Ordenes abiertas: ${orders?.length ?? 0}`);
      console.log('\nListo para trading real.\n');
      return;
    } catch {
      if (i < 6) {
        console.log(`   Intento ${i}/6 fallido, esperando 20s...`);
        await new Promise(r => setTimeout(r, 20_000));
      }
    }
  }

  console.warn('\n⚠️  La verificacion fallo pero las credenciales pueden ser validas.');
  console.warn('   Guarda los valores de .env y prueba en unos minutos.\n');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});