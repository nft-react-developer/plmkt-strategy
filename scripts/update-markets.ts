// scripts/backfill-market-slugs.ts
//
// Rellena market_slug en posiciones existentes consultando la Gamma API.
//
// Uso:
//   ts-node scripts/backfill-market-slugs.ts            # solo abiertas
//   ts-node scripts/backfill-market-slugs.ts --all      # todas
//   ts-node scripts/backfill-market-slugs.ts --debug    # muestra respuesta cruda de API

import 'dotenv/config';
import { eq, isNull, and } from 'drizzle-orm';
import { getDb, closeDb } from '../db/connection';
import { positions } from '../db/schema';

const ALL        = process.argv.includes('--all');
const DEBUG      = process.argv.includes('--debug');

const GAMMA_BASE_URL = 'https://gamma-api.polymarket.com';

async function fetchSlug(conditionId: string, question: string): Promise<string | null> {
  // Buscar por texto en Gamma API y verificar conditionId exacto
  // Paginar si es necesario hasta encontrarlo
  const searchTerms = [
    question.slice(0, 60),   // primeras 60 chars de la pregunta
    question.slice(0, 40),   // si no aparece, intentar con menos chars
  ];

  for (const q of searchTerms) {
    try {
      const encoded = encodeURIComponent(q);
      const url     = `${GAMMA_BASE_URL}/markets?q=${encoded}&limit=20`;
      const res     = await fetch(url, { signal: AbortSignal.timeout(8_000) });
      if (!res.ok) continue;

      const data = await res.json() as Array<{ conditionId: string; slug?: string; question?: string }>;

      // Buscar el conditionId exacto en los resultados
      const match = data.find(m => m.conditionId === conditionId);
      if (match?.slug) {
        if (DEBUG) console.log(`    ✅ Encontrado por q="${q.slice(0,30)}...": ${match.slug}`);
        return match.slug;
      }

      if (DEBUG && data.length > 0) {
        console.log(`    Busqueda "${q.slice(0,30)}..." devolvio ${data.length} resultados, sin match exacto`);
        data.slice(0, 3).forEach(m => console.log(`      ${m.conditionId?.slice(0,20)} | ${m.slug}`));
      }
    } catch (err) {
      if (DEBUG) console.log(`    Error: ${err}`);
    }

    await new Promise(r => setTimeout(r, 200));
  }

  return null;
}

async function main() {
  const db = await getDb();

  const where = ALL
    ? isNull((positions as any).marketSlug)
    : and(
        isNull((positions as any).marketSlug),
        eq(positions.status, 'open'),
      );

  const rows = await db
    .select({
      id:            positions.id,
      marketId:      positions.marketId,
      marketQuestion: positions.marketQuestion,
    })
    .from(positions)
    .where(where);

  if (!rows.length) {
    console.log('No hay posiciones sin market_slug.');
    await closeDb();
    return;
  }

  console.log(`\nBackfill de ${rows.length} posicion${rows.length !== 1 ? 'es' : ''}...\n`);

  if (DEBUG) {
    console.log('-- DEBUG MODE --\n');
    const first = rows[0];
    console.log(`Posicion #${first.id}: ${first.marketQuestion}`);
    const slug = await fetchSlug(first.marketId, first.marketQuestion ?? '');
    console.log(`slug: ${slug ?? 'NO ENCONTRADO'}`);
    if (slug) console.log(`link: https://polymarket.com/event/${slug}`);
    await closeDb();
    return;
  }

  let ok = 0, failed = 0;

  for (const row of rows) {
    process.stdout.write(`  #${row.id} ${(row.marketQuestion ?? '').slice(0, 45)}... `);

    const slug = await fetchSlug(row.marketId, row.marketQuestion ?? '');

    if (slug) {
      await db
        .update(positions)
        .set({ marketSlug: slug } as any)
        .where(eq(positions.id, row.id));
      console.log(`✅ ${slug}`);
      ok++;
    } else {
      console.log('⚠️  sin slug');
      failed++;
    }

    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`\nListo — OK: ${ok} | Sin slug: ${failed}\n`);
  await closeDb();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});