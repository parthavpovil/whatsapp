import { createServer } from 'node:http';
import { Counter, Gauge, Registry, collectDefaultMetrics } from 'prom-client';
import { query } from './db.js';
import { log } from './log.js';

export const registry = new Registry();
registry.setDefaultLabels({ service: 'dispatcher' });
collectDefaultMetrics({ register: registry });

export const webhookDeliveryAttemptsTotal = new Counter({
  name: 'wa_webhook_delivery_attempts_total',
  help: 'Webhook delivery attempts',
  labelNames: ['outcome'] as const, // delivered | retriable | non_retriable
  registers: [registry],
});

export const outboxPendingCount = new Gauge({
  name: 'wa_outbox_pending_count',
  help: 'Pending events in events_outbox (sampled every 10s)',
  registers: [registry],
});

export const startMetricsServer = (port: number): { close: () => void; stop: () => void } => {
  const server = createServer(async (req, res) => {
    if (req.url !== '/metrics') {
      res.writeHead(404);
      res.end();
      return;
    }
    try {
      res.writeHead(200, { 'content-type': registry.contentType });
      res.end(await registry.metrics());
    } catch (err) {
      log.error({ err }, 'metrics endpoint error');
      res.writeHead(500);
      res.end();
    }
  });
  server.listen(port, () => log.info({ port }, 'metrics: listening'));

  let stopped = false;
  const sample = async (): Promise<void> => {
    while (!stopped) {
      try {
        const r = await query<{ c: string }>(
          `SELECT count(*)::text AS c FROM events_outbox WHERE delivered_at IS NULL`,
        );
        outboxPendingCount.set(Number.parseInt(r.rows[0]?.c ?? '0', 10));
      } catch (err) {
        log.warn({ err }, 'outbox pending sample failed');
      }
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
  };
  void sample();

  return {
    close: () => server.close(),
    stop: () => {
      stopped = true;
    },
  };
};
