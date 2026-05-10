import { CreateAccountSchema } from '@wa/shared';
import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import { query } from '../db.js';
import { log } from '../log.js';
import { accountsCreatedTotal } from '../metrics.js';

type WaAccountRow = {
  id: string;
  workspace_id: string;
  phone_number: string | null;
  status: string;
  last_qr: string | null;
  created_at: Date;
  updated_at: Date;
};

const toResponse = (row: WaAccountRow) => ({
  wa_account_id: row.id,
  workspace_id: row.workspace_id,
  status: row.status,
  phone_number: row.phone_number,
  has_qr: row.last_qr !== null,
  created_at: row.created_at.toISOString(),
  updated_at: row.updated_at.toISOString(),
});

export const registerAccounts = (app: FastifyInstance, auth: preHandlerAsyncHookHandler): void => {
  app.post('/accounts', { preHandler: auth }, async (req, reply) => {
    const parsed = CreateAccountSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: 'validation', issues: parsed.error.issues });
      return;
    }
    const { wa_account_id, workspace_id, webhook_url, webhook_secret } = parsed.data;
    const result = await query<WaAccountRow>(
      `INSERT INTO wa_accounts (id, workspace_id, status, webhook_url, webhook_secret)
       VALUES ($1, $2, 'pending', $3, $4)
       ON CONFLICT (id) DO NOTHING
       RETURNING id, workspace_id, phone_number, status, last_qr, created_at, updated_at`,
      [wa_account_id, workspace_id, webhook_url, webhook_secret],
    );
    if (result.rows.length === 1) {
      accountsCreatedTotal.inc();
      log.info({ wa_account_id, workspace_id }, 'account created');
      reply.code(201).send(toResponse(result.rows[0] as WaAccountRow));
      return;
    }
    const existing = await query<WaAccountRow>(
      `SELECT id, workspace_id, phone_number, status, last_qr, created_at, updated_at
         FROM wa_accounts WHERE id = $1`,
      [wa_account_id],
    );
    const row = existing.rows[0];
    if (!row) {
      reply.code(500).send({ error: 'internal' });
      return;
    }
    reply.code(409).send({ error: 'exists', ...toResponse(row) });
  });

  app.get<{ Params: { id: string } }>('/accounts/:id', { preHandler: auth }, async (req, reply) => {
    const { id } = req.params;
    const result = await query<WaAccountRow>(
      `SELECT id, workspace_id, phone_number, status, last_qr, created_at, updated_at
         FROM wa_accounts WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    if (!row) {
      reply.code(404).send({ error: 'not_found' });
      return;
    }
    reply.send(toResponse(row));
  });

  app.delete<{ Params: { id: string } }>(
    '/accounts/:id',
    { preHandler: auth },
    async (req, reply) => {
      const { id } = req.params;
      const result = await query<WaAccountRow>(
        `UPDATE wa_accounts SET status='disconnected', updated_at=now()
          WHERE id=$1
          RETURNING id, workspace_id, phone_number, status, last_qr, created_at, updated_at`,
        [id],
      );
      const row = result.rows[0];
      if (!row) {
        reply.code(404).send({ error: 'not_found' });
        return;
      }
      // Worker observes status change on its next lease tick and tears down the session.
      reply.code(202).send({ wa_account_id: id, status: 'disconnecting' });
    },
  );
};
