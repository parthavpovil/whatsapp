import Fastify from 'fastify';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { verify } from '../../packages/shared/src/hmac.js';
import {
  closePool as closeDispatcherPool,
  getPool as getDispatcherPool,
} from '../../services/dispatcher/src/db.js';
import { runPoller } from '../../services/dispatcher/src/poller.js';

const WORKSPACE = '00000000-0000-0000-0000-000000000001';
const ACCOUNT_ID = '30000000-0000-0000-0000-000000000001';
const WEBHOOK_SECRET = 'dispatcher-test-secret-32-bytes!';

let pgClient: pg.Client;

// Tracks webhook calls for assertions.
type ReceivedCall = {
  body: Record<string, unknown>;
  signatureOk: boolean;
  respondWith: number;
};
const received: ReceivedCall[] = [];
let defaultStatus = 200;

// Tiny in-process mock webhook server.
const mockBackend = Fastify({ logger: false });
mockBackend.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
  done(null, body);
});
mockBackend.post('/webhooks', async (req, reply) => {
  const rawBody = req.body as string;
  const sig = String(req.headers['x-wa-signature'] ?? '');
  const ok = verify(rawBody, sig, WEBHOOK_SECRET);
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    /* ignore */
  }
  received.push({ body: parsed, signatureOk: ok, respondWith: defaultStatus });
  reply.code(defaultStatus).send({ ok: true });
});

let webhookUrl: string;

beforeAll(async () => {
  const pgUrl = process.env.TEST_DATABASE_URL!;

  getDispatcherPool(pgUrl);

  pgClient = new pg.Client({ connectionString: pgUrl });
  await pgClient.connect();

  // Seed the account the dispatcher will look up for webhook_url / webhook_secret.
  await pgClient.query(
    `INSERT INTO wa_accounts (id, workspace_id, status, webhook_url, webhook_secret)
     VALUES ($1, $2, 'connected', 'placeholder', $3)
     ON CONFLICT (id) DO UPDATE SET webhook_url = EXCLUDED.webhook_url, webhook_secret = EXCLUDED.webhook_secret`,
    [ACCOUNT_ID, WORKSPACE, WEBHOOK_SECRET],
  );

  // Start mock backend on a random OS-assigned port.
  await mockBackend.listen({ port: 0, host: '127.0.0.1' });
  const addr = mockBackend.server.address() as { port: number };
  webhookUrl = `http://127.0.0.1:${addr.port}/webhooks`;

  // Update account's webhook_url now that we know the port.
  await pgClient.query('UPDATE wa_accounts SET webhook_url = $2 WHERE id = $1', [
    ACCOUNT_ID,
    webhookUrl,
  ]);
});

afterAll(async () => {
  await pgClient.query('DELETE FROM events_outbox WHERE wa_account_id = $1', [ACCOUNT_ID]);
  await pgClient.query('DELETE FROM wa_accounts WHERE id = $1', [ACCOUNT_ID]);
  await pgClient.end();
  await mockBackend.close();
  await closeDispatcherPool();
});

afterEach(() => {
  received.length = 0;
  defaultStatus = 200;
});

const insertEvent = async (eventId: string, eventType = 'message.sent_ack'): Promise<void> => {
  await pgClient.query(
    `INSERT INTO events_outbox (event_id, wa_account_id, event_type, payload, next_attempt_at)
     VALUES ($1, $2, $3, '{}', now() - interval '1 second')`,
    [eventId, ACCOUNT_ID, eventType],
  );
};

const runPollerBriefly = async (ms = 500): Promise<void> => {
  let stopped = false;
  const pollerPromise = runPoller({ httpTimeoutMs: 5_000, idleSleepMs: 50 }, () => stopped);
  await new Promise((resolve) => setTimeout(resolve, ms));
  stopped = true;
  await pollerPromise;
};

const waitFor = async (pred: () => boolean, timeoutMs = 3_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('dispatcher: basic delivery', () => {
  it('delivers an outbox event to the webhook with correct HMAC', async () => {
    const eventId = '30000000-dead-0000-0000-000000000001';
    await insertEvent(eventId);

    await runPollerBriefly();
    await waitFor(() => received.length > 0);

    expect(received.length).toBe(1);
    expect(received[0]?.signatureOk).toBe(true);
    expect((received[0]?.body as { event_id: string }).event_id).toBe(eventId);

    const { rows } = await pgClient.query<{ delivered_at: string | null }>(
      'SELECT delivered_at FROM events_outbox WHERE event_id = $1',
      [eventId],
    );
    expect(rows[0]?.delivered_at).not.toBeNull();
  });

  it('includes correct event metadata headers and payload', async () => {
    const eventId = '30000000-dead-0000-0000-000000000002';
    await insertEvent(eventId, 'message.incoming');

    await runPollerBriefly();
    await waitFor(() => received.length > 0);

    const call = received[0];
    if (!call) throw new Error('expected at least one call');
    expect(call.signatureOk).toBe(true);
    expect((call.body as Record<string, unknown>).event_type).toBe('message.incoming');
    expect((call.body as Record<string, unknown>).wa_account_id).toBe(ACCOUNT_ID);
  });
});

describe('dispatcher: retry on 5xx', () => {
  it('increments attempts and bumps next_attempt_at on 500', async () => {
    defaultStatus = 500;
    const eventId = '30000000-dead-0000-0000-000000000003';
    await insertEvent(eventId);

    await runPollerBriefly(300);

    const { rows } = await pgClient.query<{ attempts: number; delivered_at: string | null }>(
      'SELECT attempts, delivered_at FROM events_outbox WHERE event_id = $1',
      [eventId],
    );
    expect(rows[0]?.attempts).toBeGreaterThanOrEqual(1);
    expect(rows[0]?.delivered_at).toBeNull();
  });
});

describe('dispatcher: non-retriable on 4xx (not 408/429)', () => {
  it('marks event as delivered (non-retriable) on 401', async () => {
    defaultStatus = 401;
    const eventId = '30000000-dead-0000-0000-000000000004';
    await insertEvent(eventId);

    await runPollerBriefly();
    await waitFor(() => received.length > 0);

    const { rows } = await pgClient.query<{
      delivered_at: string | null;
      last_error: string | null;
    }>('SELECT delivered_at, last_error FROM events_outbox WHERE event_id = $1', [eventId]);
    // Non-retriable: delivered_at is set (closed out), last_error has "non_retriable" prefix.
    expect(rows[0]?.delivered_at).not.toBeNull();
    expect(rows[0]?.last_error).toMatch(/non_retriable/);
  });
});

describe('dispatcher: visibility lease prevents double delivery', () => {
  it('two concurrent pollers deliver each event exactly once', async () => {
    const eventIds = [
      '30000000-dead-0000-0000-000000000005',
      '30000000-dead-0000-0000-000000000006',
      '30000000-dead-0000-0000-000000000007',
    ];
    for (const id of eventIds) await insertEvent(id);

    let stopped1 = false;
    let stopped2 = false;
    const p1 = runPoller({ httpTimeoutMs: 5_000, idleSleepMs: 50 }, () => stopped1);
    const p2 = runPoller({ httpTimeoutMs: 5_000, idleSleepMs: 50 }, () => stopped2);

    // Give enough time for both pollers to process.
    await new Promise((r) => setTimeout(r, 600));
    stopped1 = true;
    stopped2 = true;
    await Promise.all([p1, p2]);

    // Each event should appear exactly once in received calls.
    for (const id of eventIds) {
      const calls = received.filter((c) => (c.body as { event_id: string }).event_id === id);
      expect(calls.length, `event ${id} delivered more than once`).toBe(1);
    }

    // All events should be marked delivered.
    const { rows } = await pgClient.query<{ event_id: string; delivered_at: string | null }>(
      'SELECT event_id, delivered_at FROM events_outbox WHERE event_id = ANY($1)',
      [eventIds],
    );
    for (const row of rows) {
      expect(row.delivered_at, `event ${row.event_id} not delivered`).not.toBeNull();
    }
  });
});
