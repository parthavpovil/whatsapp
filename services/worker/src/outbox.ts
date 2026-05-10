import type pg from 'pg';
import type { OutboxRow } from '@wa/shared';
import { query } from './db.js';

// Insert one outbox row using the pool. For tx-bundled inserts (e.g. with the
// outbound_commands UPDATE), use `insertOutboxTx` with a connected client.
export const insertOutbox = async (row: OutboxRow): Promise<void> => {
  await query(
    `INSERT INTO events_outbox (event_id, wa_account_id, event_type, payload)
     VALUES ($1, $2, $3, $4)`,
    [row.event_id, row.wa_account_id, row.event_type, row.payload],
  );
};

export const insertOutboxTx = async (
  client: pg.PoolClient,
  row: OutboxRow,
): Promise<void> => {
  await client.query(
    `INSERT INTO events_outbox (event_id, wa_account_id, event_type, payload)
     VALUES ($1, $2, $3, $4)`,
    [row.event_id, row.wa_account_id, row.event_type, row.payload],
  );
};
