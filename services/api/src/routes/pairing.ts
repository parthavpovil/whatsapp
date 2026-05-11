import { RedisKeys } from '@wa/shared';
import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import type { Redis } from 'ioredis';
import { query } from '../db.js';
import { log } from '../log.js';

const POLL_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 500;

export const registerPairingCode = (
  app: FastifyInstance,
  redis: Redis,
  auth: preHandlerAsyncHookHandler,
): void => {
  app.post<{ Params: { id: string }; Body: { phone_number: string } }>(
    '/accounts/:id/pairing-code',
    { preHandler: auth },
    async (req, reply) => {
      const { id } = req.params;
      const { phone_number } = req.body;

      if (!phone_number || !/^\d{7,15}$/.test(phone_number)) {
        return reply.code(400).send({ error: 'phone_number must be digits only, 7–15 chars (E.164 without +)' });
      }

      const { rows } = await query<{ status: string }>(
        'SELECT status FROM wa_accounts WHERE id=$1',
        [id],
      );
      if (rows.length === 0 || !rows[0]) return reply.code(404).send({ error: 'not_found' });
      if (!['pending', 'qr_required', 'disconnected'].includes(rows[0].status)) {
        return reply.code(409).send({ error: 'account_already_connected', status: rows[0].status });
      }

      // Store phone so the worker picks it up on the next qr event.
      await redis.set(RedisKeys.pairingPhone(id), phone_number, 'EX', RedisKeys.TTL.pairingPhoneSec);

      // Check if a code was already generated (worker may have fired qr already).
      const existing = await redis.get(RedisKeys.pairingCode(id));
      if (existing) return reply.code(200).send({ code: existing });

      // Subscribe and long-poll for the code.
      const sub = redis.duplicate();
      const channel = RedisKeys.pairingChannel(id);
      let code: string | null = null;

      try {
        await sub.subscribe(channel);
        const codePromise = new Promise<string>((resolve) => {
          sub.on('message', (_ch, payload) => {
            try {
              const parsed = JSON.parse(payload) as { code: string };
              if (parsed.code) resolve(parsed.code);
            } catch { /* ignore */ }
          });
        });

        const deadline = Date.now() + POLL_TIMEOUT_MS;
        while (!code && Date.now() < deadline) {
          code = await redis.get(RedisKeys.pairingCode(id));
          if (code) break;
          await Promise.race([
            codePromise.then((c) => { code = c; }),
            new Promise((r) => setTimeout(r, POLL_INTERVAL_MS)),
          ]);
        }
      } catch (err) {
        log.error({ err, waAccountId: id }, 'pairing-code subscribe failed');
      } finally {
        await sub.unsubscribe(channel).catch(() => undefined);
        sub.disconnect();
      }

      if (!code) return reply.code(504).send({ error: 'timeout_waiting_for_code', hint: 'Worker may still be initializing — retry in a few seconds' });
      return reply.code(200).send({ code });
    },
  );
};
