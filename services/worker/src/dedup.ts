import type { Redis } from 'ioredis';
import type pg from 'pg';
import { RedisKeys } from '@wa/shared';

// Two-stage dedup. First stage is a Redis SETNX (cheap, fast); second stage is
// a Postgres INSERT ... ON CONFLICT DO NOTHING in the SAME transaction as the
// outbox INSERT. The Redis stage exists to avoid hitting PG for the common case
// of a true duplicate replay; the PG stage is the source of truth.
//
// Race-safety: if Redis says "new" but PG says "duplicate" (e.g. dedup TTL
// expired and replay happened later than 24h), PG wins.
export const dedupRedis = async (
  redis: Redis,
  waAccountId: string,
  waMessageId: string,
): Promise<boolean> => {
  const set = await redis.set(
    RedisKeys.dedupEvent(waAccountId, waMessageId),
    '1',
    'EX',
    RedisKeys.TTL.dedupEventSec,
    'NX',
  );
  return set !== null;
};

// Returns true if THIS call inserted the row (i.e. message is new).
// Returns false if a previous insert already exists (duplicate).
export const dedupPgTx = async (
  client: pg.PoolClient,
  waAccountId: string,
  waMessageId: string,
): Promise<boolean> => {
  const result = await client.query(
    `INSERT INTO seen_wa_messages (wa_account_id, wa_message_id)
     VALUES ($1, $2)
     ON CONFLICT (wa_account_id, wa_message_id) DO NOTHING`,
    [waAccountId, waMessageId],
  );
  return (result.rowCount ?? 0) > 0;
};
