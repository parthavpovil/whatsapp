import { S3Client } from '@aws-sdk/client-s3';
import { RedisKeys, WorkerEnvSchema, loadEnv, parseAllowedHosts } from '@wa/shared';
import { closePool, getPool } from './db.js';
import { writeHeartbeat, writeOwnerKey } from './heartbeat.js';
import { ownedAccounts, renewLeases } from './lease.js';
import { log } from './log.js';
import type { MediaConfig } from './media.js';
import { chromiumRssBytes, startMetricsServer, workerSessionsCount } from './metrics.js';
import { QueueConsumer } from './queue-consumer.js';
import { RateLimiter } from './ratelimit.js';
import { closeRedis, getControl, newBlockingClient } from './redis.js';
import { SessionManager } from './session-manager.js';

const HEARTBEAT_INTERVAL_MS = 10_000;
const LEASE_TICK_INTERVAL_MS = 5_000;
const MEMORY_CHECK_INTERVAL_MS = 60_000;
const METRICS_PORT = Number.parseInt(process.env.WORKER_METRICS_PORT ?? '9090', 10);

const main = async (): Promise<void> => {
  const env = loadEnv(WorkerEnvSchema);
  log.info({ worker_id: env.WORKER_ID, max_sessions: env.MAX_SESSIONS }, 'worker: starting');

  getPool(env.DATABASE_URL);
  const redis = getControl(env.REDIS_URL);

  const s3 = new S3Client({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    },
  });
  const media: MediaConfig = {
    s3,
    bucket: env.S3_BUCKET,
    allowedHosts: parseAllowedHosts(env.OUTBOUND_MEDIA_ALLOWED_HOSTS),
    maxBytes: env.OUTBOUND_MEDIA_MAX_BYTES,
    presignedExpiresSec: 7 * 24 * 60 * 60, // 7 days
  };

  const rateLimiter = new RateLimiter(redis, {
    capacity: env.RATELIMIT_CAPACITY,
    refillPerSec: env.RATELIMIT_REFILL_PER_SEC,
  });

  const sessions = new SessionManager({
    redis,
    dataPathRoot: env.WWEBJS_CACHE_DIR,
    puppeteerExecutablePath: env.PUPPETEER_EXECUTABLE_PATH,
    webVersionCachePath: `${env.WWEBJS_CACHE_DIR}/web-version`,
    media,
    rateLimiter,
  });

  const brpopClient = newBlockingClient(env.REDIS_URL);
  const consumer = new QueueConsumer({
    brpopClient,
    workerId: env.WORKER_ID,
    sessions,
  });

  const metricsServer = startMetricsServer(METRICS_PORT);

  let stopped = false;

  const heartbeatLoop = async (): Promise<void> => {
    while (!stopped) {
      try {
        const size = sessions.size();
        await writeHeartbeat(redis, env.WORKER_ID, size);
        workerSessionsCount.set(size);
        for (const id of sessions.ids()) {
          await writeOwnerKey(redis, id, env.WORKER_ID);
        }
      } catch (err) {
        log.error({ err }, 'heartbeat tick failed');
      }
      await sleep(HEARTBEAT_INTERVAL_MS);
    }
  };

  const memoryLoop = async (): Promise<void> => {
    const maxRssBytes = env.MAX_RSS_MB * 1024 * 1024;
    while (!stopped) {
      const rss = process.memoryUsage().rss;
      chromiumRssBytes.set(rss);
      if (rss > maxRssBytes) {
        log.warn({ rss, max: maxRssBytes }, 'memory: RSS over threshold, triggering shutdown');
        void shutdown('MEMORY_THRESHOLD');
        return;
      }
      await sleep(MEMORY_CHECK_INTERVAL_MS);
    }
  };

  const leaseTick = async (): Promise<void> => {
    while (!stopped) {
      try {
        const owned = await ownedAccounts(env.WORKER_ID);
        const ownedIds = new Set(owned.map((a) => a.id));

        // Renew leases on currently held accounts.
        await renewLeases(env.WORKER_ID, Array.from(ownedIds));

        // Add sessions for newly assigned accounts.
        for (const account of owned) {
          if (!sessions.has(account.id) && sessions.size() < env.MAX_SESSIONS) {
            log.info({ wa_account_id: account.id }, 'lease tick: adding session');
            await sessions.add(account.id);
          }
        }

        // Remove sessions whose lease was reassigned away (or status flipped).
        for (const id of sessions.ids()) {
          if (!ownedIds.has(id)) {
            log.info({ wa_account_id: id }, 'lease tick: lost lease, removing session');
            await sessions.remove(id);
          }
        }
      } catch (err) {
        log.error({ err }, 'lease tick failed');
      }
      await sleep(LEASE_TICK_INTERVAL_MS);
    }
  };

  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, 'worker: shutting down');
    stopped = true;
    // Mark draining so allocator skips us.
    try {
      await redis.set(RedisKeys.workerDraining(env.WORKER_ID), '1', 'EX', 120);
    } catch (err) {
      log.warn({ err }, 'shutdown: failed to set draining flag');
    }
    await consumer.stop().catch(() => undefined);
    await sessions.destroyAll();
    // Release all our leases so the allocator can reassign immediately.
    for (const id of sessions.ids()) {
      // sessions already cleared above, but defensive
      await redis.del(RedisKeys.sessionOwner(id)).catch(() => undefined);
    }
    metricsServer.close();
    brpopClient.disconnect();
    await closeRedis().catch(() => undefined);
    await closePool().catch(() => undefined);
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  void heartbeatLoop();
  void leaseTick();
  void memoryLoop();
  void consumer.run();

  log.info('worker: ready');
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

void main().catch((err) => {
  log.error({ err }, 'worker: fatal during startup');
  process.exit(1);
});
