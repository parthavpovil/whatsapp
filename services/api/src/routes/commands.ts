import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import { OutboundCommandSchema, RedisKeys } from '@wa/shared';
import { query } from '../db.js';
import { log } from '../log.js';
import { commandsReceivedTotal } from '../metrics.js';
import { getRedis } from '../redis.js';

type WaAccountRow = {
  status: string;
  worker_id: string | null;
  lease_expires_at: Date | null;
};

type CommandRow = {
  command_id: string;
  status: string;
  wa_message_id: string | null;
  last_error: string | null;
};

export const registerCommands = (
  app: FastifyInstance,
  auth: preHandlerAsyncHookHandler,
  redisUrl: string,
): void => {
  const redis = getRedis(redisUrl);

  app.post('/commands', { preHandler: auth }, async (req, reply) => {
    const parsed = OutboundCommandSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: 'validation', issues: parsed.error.issues });
      return;
    }
    const cmd = parsed.data;

    // Fast-path idempotency check: SETNX dedup:command:{id}.
    // If it already existed, the command was previously seen; return current state.
    const setRes = await redis.set(
      RedisKeys.dedupCommand(cmd.command_id),
      '1',
      'EX',
      RedisKeys.TTL.dedupCommandSec,
      'NX',
    );
    if (setRes === null) {
      const existing = await query<CommandRow>(
        `SELECT command_id, status, wa_message_id, last_error
           FROM outbound_commands WHERE command_id = $1`,
        [cmd.command_id],
      );
      const row = existing.rows[0];
      if (row) {
        reply.code(202).send({
          command_id: row.command_id,
          status: row.status,
          wa_message_id: row.wa_message_id,
          last_error: row.last_error,
        });
        return;
      }
      // Redis says we've seen it but PG doesn't have it — extremely rare race
      // (api crashed between SETNX and INSERT). Fall through and INSERT.
    }

    // Look up the account + worker assignment.
    const acct = await query<WaAccountRow>(
      `SELECT status, worker_id, lease_expires_at FROM wa_accounts WHERE id = $1`,
      [cmd.wa_account_id],
    );
    const account = acct.rows[0];
    if (!account) {
      reply.code(404).send({ error: 'account_not_found' });
      return;
    }
    if (account.status !== 'connected') {
      reply.code(409).send({ error: 'account_not_connected', status: account.status });
      return;
    }

    // Insert idempotent row. ON CONFLICT preserves prior state.
    const insertRes = await query<CommandRow>(
      `INSERT INTO outbound_commands (command_id, wa_account_id, payload, status)
       VALUES ($1, $2, $3, 'queued')
       ON CONFLICT (command_id) DO NOTHING
       RETURNING command_id, status, wa_message_id, last_error`,
      [cmd.command_id, cmd.wa_account_id, cmd],
    );
    if (insertRes.rows.length === 0) {
      const existing = await query<CommandRow>(
        `SELECT command_id, status, wa_message_id, last_error
           FROM outbound_commands WHERE command_id = $1`,
        [cmd.command_id],
      );
      const row = existing.rows[0];
      if (row) {
        reply.code(202).send({
          command_id: row.command_id,
          status: row.status,
          wa_message_id: row.wa_message_id,
          last_error: row.last_error,
        });
        return;
      }
    }

    // Resolve worker. Prefer Redis (fast); fall back to PG.
    let workerId = await redis.get(RedisKeys.sessionOwner(cmd.wa_account_id));
    if (!workerId) workerId = account.worker_id;
    if (!workerId) {
      reply.code(503).send({ error: 'no_worker_assigned' });
      return;
    }

    // Enqueue.
    const queueMessage = JSON.stringify({
      enqueued_at: new Date().toISOString(),
      command: cmd,
    });
    await redis.lpush(RedisKeys.workerQueue(workerId), queueMessage);

    log.info(
      { command_id: cmd.command_id, wa_account_id: cmd.wa_account_id, worker_id: workerId },
      'command queued',
    );
    commandsReceivedTotal.inc({ result: 'queued' });
    reply.code(202).send({ command_id: cmd.command_id, status: 'queued' });
  });
};
