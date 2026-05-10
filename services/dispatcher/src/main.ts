import { DispatcherEnvSchema, loadEnv } from '@wa/shared';
import { closePool, getPool } from './db.js';
import { log } from './log.js';
import { startMetricsServer } from './metrics.js';
import { runPoller } from './poller.js';

const METRICS_PORT = Number.parseInt(process.env.DISPATCHER_METRICS_PORT ?? '9091', 10);

const main = async (): Promise<void> => {
  const env = loadEnv(DispatcherEnvSchema);
  log.info(
    { concurrency: env.DISPATCHER_CONCURRENCY, http_timeout_ms: env.DISPATCHER_HTTP_TIMEOUT_MS },
    'dispatcher: starting',
  );
  getPool(env.DATABASE_URL);
  const metricsServer = startMetricsServer(METRICS_PORT);

  let stopped = false;
  const isStopped = (): boolean => stopped;

  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, 'dispatcher: shutting down');
    stopped = true;
    // Workers exit their loops within idleSleepMs; give them a beat then close pool.
    await sleep(2_000);
    metricsServer.stop();
    metricsServer.close();
    await closePool().catch(() => undefined);
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  const runners: Promise<void>[] = [];
  for (let i = 0; i < env.DISPATCHER_CONCURRENCY; i++) {
    runners.push(
      runPoller({ httpTimeoutMs: env.DISPATCHER_HTTP_TIMEOUT_MS }, isStopped).catch((err) =>
        log.error({ err, slot: i }, 'poller crashed'),
      ),
    );
  }
  log.info({ runners: runners.length }, 'dispatcher: ready');
  await Promise.all(runners);
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

void main().catch((err) => {
  log.error({ err }, 'dispatcher: fatal during startup');
  process.exit(1);
});
