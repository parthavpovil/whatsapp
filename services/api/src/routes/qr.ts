import { RedisKeys } from '@wa/shared';
import type { FastifyInstance, FastifyReply, preHandlerAsyncHookHandler } from 'fastify';
import type { Redis } from 'ioredis';
import { log } from '../log.js';

const SSE_PING_INTERVAL_MS = 15_000;
const SSE_HARD_TIMEOUT_MS = 5 * 60 * 1_000;
const LONG_POLL_TIMEOUT_MS = 30_000;
const LONG_POLL_INTERVAL_MS = 1_000;

const writeSse = (reply: FastifyReply, event: string, data: string): void => {
  reply.raw.write(`event: ${event}\n`);
  reply.raw.write(`data: ${data}\n\n`);
};

export const registerQr = (
  app: FastifyInstance,
  redis: Redis,
  auth: preHandlerAsyncHookHandler,
): void => {
  app.get<{ Params: { id: string } }>(
    '/accounts/:id/qr',
    { preHandler: auth },
    async (req, reply) => {
      const { id } = req.params;
      const wantsSse = (req.headers.accept ?? '').includes('text/event-stream');

      if (wantsSse) {
        await streamQrSse(reply, redis, id);
        return reply;
      }
      await longPollQr(reply, redis, id);
      return reply;
    },
  );
};

const streamQrSse = async (
  reply: FastifyReply,
  redis: Redis,
  waAccountId: string,
): Promise<void> => {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  reply.raw.flushHeaders?.();

  // Dedicated Redis subscriber connection — Pub/Sub puts the connection in subscribe mode.
  const sub = redis.duplicate();
  const channel = RedisKeys.qrChannel(waAccountId);

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(pingTimer);
    clearTimeout(hardTimer);
    sub.unsubscribe(channel).catch(() => undefined);
    sub.disconnect();
    if (!reply.raw.writableEnded) reply.raw.end();
  };

  reply.raw.on('close', close);
  reply.raw.on('error', close);

  const pingTimer = setInterval(() => {
    if (!reply.raw.writableEnded) reply.raw.write(': ping\n\n');
  }, SSE_PING_INTERVAL_MS);

  const hardTimer = setTimeout(close, SSE_HARD_TIMEOUT_MS);

  try {
    // Send any cached QR immediately.
    const cached = await redis.get(RedisKeys.sessionQr(waAccountId));
    if (cached) writeSse(reply, 'qr', JSON.stringify({ qr_base64: cached }));

    await sub.subscribe(channel);
    sub.on('message', (_ch, payload) => {
      try {
        const parsed = JSON.parse(payload) as { type: string; data?: string };
        if (parsed.type === 'qr' && parsed.data) {
          writeSse(reply, 'qr', JSON.stringify({ qr_base64: parsed.data }));
        } else if (parsed.type === 'status' && parsed.data) {
          writeSse(reply, 'status', JSON.stringify({ status: parsed.data }));
          if (parsed.data === 'connected') close();
        }
      } catch (err) {
        log.warn({ err, payload }, 'qr channel: bad message');
      }
    });
  } catch (err) {
    log.error({ err, waAccountId }, 'qr SSE failed');
    writeSse(reply, 'error', JSON.stringify({ error: 'subscribe_failed' }));
    close();
  }
};

const longPollQr = async (
  reply: FastifyReply,
  redis: Redis,
  waAccountId: string,
): Promise<void> => {
  const deadline = Date.now() + LONG_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const cached = await redis.get(RedisKeys.sessionQr(waAccountId));
    if (cached) {
      reply.code(200).send({ qr: cached, status: 'qr_required' });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, LONG_POLL_INTERVAL_MS));
  }
  reply.code(204).send();
};
