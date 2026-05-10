import { createServer } from 'node:http';
import { Counter, Gauge, Registry, collectDefaultMetrics } from 'prom-client';
import { log } from './log.js';

export const registry = new Registry();
registry.setDefaultLabels({ service: 'worker' });
collectDefaultMetrics({ register: registry });

export const messagesSentTotal = new Counter({
  name: 'wa_messages_sent_total',
  help: 'Outbound messages successfully sent via wwebjs',
  labelNames: ['type'] as const,
  registers: [registry],
});

export const messagesFailedTotal = new Counter({
  name: 'wa_messages_failed_total',
  help: 'Outbound messages that failed to send',
  registers: [registry],
});

export const messagesIncomingTotal = new Counter({
  name: 'wa_messages_incoming_total',
  help: 'Inbound messages received and queued for delivery',
  registers: [registry],
});

export const workerSessionsCount = new Gauge({
  name: 'wa_worker_sessions_count',
  help: 'Currently active wwebjs sessions on this worker',
  registers: [registry],
});

export const chromiumRssBytes = new Gauge({
  name: 'wa_chromium_rss_bytes',
  help: 'Resident set size of the worker process (proxy for chromium memory)',
  registers: [registry],
});

export const startMetricsServer = (port: number): { close: () => void } => {
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
  return { close: () => server.close() };
};
