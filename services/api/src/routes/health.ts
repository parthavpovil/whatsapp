import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { query } from '../db.js';
import { registry } from '../metrics.js';

export const registerHealth = (app: FastifyInstance, redis: Redis): void => {
  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/metrics', async (_req, reply) => {
    reply.header('content-type', registry.contentType);
    reply.send(await registry.metrics());
  });

  app.get('/ready', async (_req, reply) => {
    const checks: Record<string, string> = {};
    try {
      await query('SELECT 1');
      checks['postgres'] = 'ok';
    } catch (err) {
      checks['postgres'] = err instanceof Error ? err.message : 'error';
    }
    try {
      const pong = await redis.ping();
      checks['redis'] = pong === 'PONG' ? 'ok' : `unexpected:${pong}`;
    } catch (err) {
      checks['redis'] = err instanceof Error ? err.message : 'error';
    }
    const ok = Object.values(checks).every((v) => v === 'ok');
    reply.code(ok ? 200 : 503).send({ status: ok ? 'ready' : 'not_ready', checks });
  });
};
