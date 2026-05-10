import pg from 'pg';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Tests the two-layer inbound dedup invariant:
 * - Layer 1: Redis SETNX (fast, per-process)
 * - Layer 2: Postgres INSERT ON CONFLICT (durable, cross-process)
 *
 * The critical property: two concurrent calls for the same (account, wa_message_id)
 * must produce exactly one row in seen_wa_messages and exactly one row in events_outbox.
 */

const WORKSPACE = '00000000-0000-0000-0000-000000000001';
const ACCOUNT_ID = '40000000-0000-0000-0000-000000000001';
const WEBHOOK_URL = 'http://localhost:9999/webhooks';
const WEBHOOK_SECRET = 'dedup-test-secret-32-bytes-xxxxx';

let pool: pg.Pool;
let redis: Redis;

beforeAll(async () => {
  const pgUrl = process.env['TEST_DATABASE_URL']!;
  const redisUrl = process.env['TEST_REDIS_URL']!;

  pool = new pg.Pool({ connectionString: pgUrl, max: 5 });
  redis = new Redis(redisUrl);

  await pool.query(
    `INSERT INTO wa_accounts (id, workspace_id, status, webhook_url, webhook_secret)
     VALUES ($1, $2, 'connected', $3, $4)
     ON CONFLICT DO NOTHING`,
    [ACCOUNT_ID, WORKSPACE, WEBHOOK_URL, WEBHOOK_SECRET],
  );
});

afterAll(async () => {
  await pool.query('DELETE FROM events_outbox WHERE wa_account_id = $1', [ACCOUNT_ID]);
  await pool.query('DELETE FROM seen_wa_messages WHERE wa_account_id = $1', [ACCOUNT_ID]);
  await pool.query('DELETE FROM wa_accounts WHERE id = $1', [ACCOUNT_ID]);
  await pool.end();
  redis.disconnect();
});

// Replicates the logic in services/worker/src/dedup.ts + handlers/on-message.ts
// without importing whatsapp-web.js. Tests the SQL invariants directly.

const dedupRedis = async (accountId: string, msgId: string): Promise<boolean> => {
  const key = `dedup:event:${accountId}:${msgId}`;
  const result = await redis.set(key, '1', 'EX', 86400, 'NX');
  return result === 'OK';
};

const insertMessageAndEvent = async (
  accountId: string,
  waMessageId: string,
  eventId: string,
): Promise<boolean> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const seenRes = await client.query<{ wa_message_id: string }>(
      `INSERT INTO seen_wa_messages (wa_account_id, wa_message_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING
       RETURNING wa_message_id`,
      [accountId, waMessageId],
    );

    if (seenRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return false; // duplicate
    }

    await client.query(
      `INSERT INTO events_outbox (event_id, wa_account_id, event_type, payload)
       VALUES ($1, $2, 'message.incoming', '{"test":true}')`,
      [eventId, accountId],
    );

    await client.query('COMMIT');
    return true; // new
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
};

describe('inbound dedup: Redis layer', () => {
  it('first call returns true, second call returns false for same msgId', async () => {
    const msgId = 'wa-msg-redis-dedup-test-1';
    const first = await dedupRedis(ACCOUNT_ID, msgId);
    const second = await dedupRedis(ACCOUNT_ID, msgId);
    expect(first).toBe(true);
    expect(second).toBe(false);
  });
});

describe('inbound dedup: Postgres layer', () => {
  it('exactly one row in seen_wa_messages for concurrent inserts with same msgId', async () => {
    const msgId = 'wa-msg-pg-dedup-test-1';
    const eventId1 = '40000000-0000-cafe-0000-000000000001';
    const eventId2 = '40000000-0000-cafe-0000-000000000002';

    const [r1, r2] = await Promise.all([
      insertMessageAndEvent(ACCOUNT_ID, msgId, eventId1),
      insertMessageAndEvent(ACCOUNT_ID, msgId, eventId2),
    ]);

    // Exactly one succeeded.
    expect([r1, r2].filter(Boolean).length).toBe(1);

    const { rows: seenRows } = await pool.query<{ wa_message_id: string }>(
      'SELECT wa_message_id FROM seen_wa_messages WHERE wa_account_id = $1 AND wa_message_id = $2',
      [ACCOUNT_ID, msgId],
    );
    expect(seenRows.length).toBe(1);

    // Only one event in outbox (the one from the successful insert).
    const { rows: outboxRows } = await pool.query<{ event_id: string }>(
      `SELECT event_id FROM events_outbox
        WHERE wa_account_id = $1 AND event_id IN ($2, $3)`,
      [ACCOUNT_ID, eventId1, eventId2],
    );
    expect(outboxRows.length).toBe(1);
  });

  it('does not strand a deduped message without an outbox event', async () => {
    // Run multiple concurrent attempts and verify the atomicity invariant:
    // For every row in seen_wa_messages there is exactly one row in events_outbox.
    const msgId = 'wa-msg-atomicity-test-1';
    const eventIds = Array.from({ length: 5 }, (_, i) =>
      `40000000-0000-cafe-0001-${String(i).padStart(12, '0')}`,
    );

    await Promise.all(
      eventIds.map((eid, i) => insertMessageAndEvent(ACCOUNT_ID, msgId, eid).catch(() => i)),
    );

    const { rows: seenRows } = await pool.query(
      'SELECT COUNT(*) AS cnt FROM seen_wa_messages WHERE wa_account_id = $1 AND wa_message_id = $2',
      [ACCOUNT_ID, msgId],
    );
    expect(Number((seenRows[0] as { cnt: string }).cnt)).toBe(1);

    const { rows: outboxRows } = await pool.query(
      `SELECT COUNT(*) AS cnt FROM events_outbox WHERE wa_account_id = $1 AND event_id = ANY($2)`,
      [ACCOUNT_ID, eventIds],
    );
    // Exactly one outbox event for this message.
    expect(Number((outboxRows[0] as { cnt: string }).cnt)).toBe(1);
  });
});
