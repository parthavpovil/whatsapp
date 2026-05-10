import { ApiEnvSchema, loadEnv } from '@wa/shared';
import { startAllocator } from './allocator.js';
import { makeApp } from './app.js';
import { closePool } from './db.js';
import { log } from './log.js';
import { closeRedis, getRedis } from './redis.js';

const main = async (): Promise<void> => {
  const env = loadEnv(ApiEnvSchema);

  const app = makeApp({
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    sharedSecret: env.BACKEND_TO_WA_SHARED_SECRET,
    logLevel: env.LOG_LEVEL,
    nodeEnv: env.NODE_ENV,
  });

  const redis = getRedis(env.REDIS_URL);
  const allocator = startAllocator(redis);

  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, 'api: shutting down');
    allocator.stop();
    try {
      await app.close();
    } catch (err) {
      log.error({ err }, 'api: error closing fastify');
    }
    await closeRedis().catch(() => undefined);
    await closePool().catch(() => undefined);
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  try {
    await app.listen({ port: env.PORT, host: '0.0.0.0' });
    log.info({ port: env.PORT }, 'api: listening');
  } catch (err) {
    log.error({ err }, 'api: failed to start');
    process.exit(1);
  }
};

void main();
