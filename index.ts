import * as dotenv from 'dotenv';
dotenv.config();
import { startRunner, stopRunner, getActiveStrategies } from './core/runner';
import { testConnection, closeDb, getDb } from './db/connection';
import { telegram } from './telegram/notifier';
import { logger } from './utils/logger';

async function main() {
  logger.info('🔄 Connecting to database...');
   await getDb();
  const ok = await testConnection();
  if (!ok) {
    logger.error('❌ Database connection failed. Check env vars.');
    process.exit(1);
  }
  logger.info('✅ Database connected');

  await startRunner();

  const active = getActiveStrategies();
  await telegram.sendStartup(active);

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`📴 ${signal} received, shutting down...`);
    await stopRunner();
    await closeDb();
    process.exit(0);
  };

  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(err => {
  logger.error('Fatal error', err);
  process.exit(1);
});