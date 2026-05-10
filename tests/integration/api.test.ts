import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp } from '../../services/api/src/app.js';
import { closePool } from '../../services/api/src/db.js';
import { closeRedis } from '../../services/api/src/redis.js';

const SECRET = 'test-secret-must-be-32-bytes-xxx';
const WORKSPACE = '00000000-0000-0000-0000-000000000001';
const WEBHOOK_URL = 'http://localhost:9999/webhooks';
const WEBHOOK_SECRET = 'test-webhook-secret-32-bytes-xxx';

let app: FastifyInstance;
let pgClient: pg.Client;

beforeAll(async () => {
  const pgUrl = process.env.TEST_DATABASE_URL!;
  const redisUrl = process.env.TEST_REDIS_URL!;

  app = makeApp({ databaseUrl: pgUrl, redisUrl, sharedSecret: SECRET, logLevel: 'silent' });
  await app.ready();

  pgClient = new pg.Client({ connectionString: pgUrl });
  await pgClient.connect();
});

afterAll(async () => {
  await pgClient.query(
    'TRUNCATE wa_accounts, outbound_commands, events_outbox, seen_wa_messages, wa_session_blobs CASCADE',
  );
  await pgClient.end();
  await app.close();
  await closeRedis();
  await closePool();
});

const authHeader = { authorization: `Bearer ${SECRET}` };

// ── /health & /ready ─────────────────────────────────────────────────────────

describe('GET /health', () => {
  it('returns 200 without auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok' });
  });
});

describe('GET /ready', () => {
  it('returns 200 when pg and redis are up', async () => {
    const res = await app.inject({ method: 'GET', url: '/ready', headers: authHeader });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; checks: Record<string, string> };
    expect(body.status).toBe('ready');
    expect(body.checks.postgres).toBe('ok');
    expect(body.checks.redis).toBe('ok');
  });
});

// ── /accounts ─────────────────────────────────────────────────────────────────

describe('POST /accounts', () => {
  it('returns 401 without bearer token', async () => {
    const res = await app.inject({ method: 'POST', url: '/accounts', payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it('returns 400 on invalid body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/accounts',
      headers: authHeader,
      payload: { bad: 'body' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('creates an account and returns 201', async () => {
    const id = '10000000-0000-0000-0000-000000000001';
    const res = await app.inject({
      method: 'POST',
      url: '/accounts',
      headers: authHeader,
      payload: {
        wa_account_id: id,
        workspace_id: WORKSPACE,
        webhook_url: WEBHOOK_URL,
        webhook_secret: WEBHOOK_SECRET,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { wa_account_id: string; status: string };
    expect(body.wa_account_id).toBe(id);
    expect(body.status).toBe('pending');
  });

  it('returns 409 on duplicate account', async () => {
    const id = '10000000-0000-0000-0000-000000000002';
    const payload = {
      wa_account_id: id,
      workspace_id: WORKSPACE,
      webhook_url: WEBHOOK_URL,
      webhook_secret: WEBHOOK_SECRET,
    };
    await app.inject({ method: 'POST', url: '/accounts', headers: authHeader, payload });
    const res = await app.inject({
      method: 'POST',
      url: '/accounts',
      headers: authHeader,
      payload,
    });
    expect(res.statusCode).toBe(409);
    const body = res.json() as { error: string };
    expect(body.error).toBe('exists');
  });
});

describe('GET /accounts/:id', () => {
  it('returns 404 for unknown account', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/accounts/00000000-0000-0000-0000-deadbeef0000',
      headers: authHeader,
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 200 for existing account', async () => {
    const id = '10000000-0000-0000-0000-000000000003';
    await app.inject({
      method: 'POST',
      url: '/accounts',
      headers: authHeader,
      payload: {
        wa_account_id: id,
        workspace_id: WORKSPACE,
        webhook_url: WEBHOOK_URL,
        webhook_secret: WEBHOOK_SECRET,
      },
    });
    const res = await app.inject({ method: 'GET', url: `/accounts/${id}`, headers: authHeader });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { wa_account_id: string; status: string; has_qr: boolean };
    expect(body.wa_account_id).toBe(id);
    expect(body.status).toBe('pending');
    expect(body.has_qr).toBe(false);
  });
});

describe('DELETE /accounts/:id', () => {
  it('returns 404 for unknown account', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/accounts/00000000-0000-0000-0000-deadbeef0001',
      headers: authHeader,
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 202 for existing account', async () => {
    const id = '10000000-0000-0000-0000-000000000004';
    await app.inject({
      method: 'POST',
      url: '/accounts',
      headers: authHeader,
      payload: {
        wa_account_id: id,
        workspace_id: WORKSPACE,
        webhook_url: WEBHOOK_URL,
        webhook_secret: WEBHOOK_SECRET,
      },
    });
    const res = await app.inject({ method: 'DELETE', url: `/accounts/${id}`, headers: authHeader });
    expect(res.statusCode).toBe(202);
    expect((res.json() as { wa_account_id: string }).wa_account_id).toBe(id);
  });
});

// ── /commands ─────────────────────────────────────────────────────────────────

describe('POST /commands', () => {
  const cmdId = '20000000-0000-0000-0000-000000000001';
  const connectedAcctId = '10000000-0000-0000-0000-000000000010';

  beforeAll(async () => {
    // Insert a connected account (no worker) for command tests.
    await pgClient.query(
      `INSERT INTO wa_accounts (id, workspace_id, status, webhook_url, webhook_secret)
       VALUES ($1, $2, 'connected', $3, $4)
       ON CONFLICT DO NOTHING`,
      [connectedAcctId, WORKSPACE, WEBHOOK_URL, WEBHOOK_SECRET],
    );
  });

  it('returns 401 without auth', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/commands',
      payload: {
        command_id: cmdId,
        wa_account_id: connectedAcctId,
        to: '15551234567',
        type: 'text',
        payload: { body: 'hi' },
      },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 400 on invalid body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/commands',
      headers: authHeader,
      payload: { bad: 'body' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 when account does not exist', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/commands',
      headers: authHeader,
      payload: {
        command_id: '20000000-0000-0000-0000-000000000002',
        wa_account_id: '00000000-0000-0000-0000-deadbeef0002',
        to: '15551234567',
        type: 'text',
        payload: { body: 'hi' },
      },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 409 when account is not connected', async () => {
    const pendingId = '10000000-0000-0000-0000-000000000011';
    await pgClient.query(
      `INSERT INTO wa_accounts (id, workspace_id, status, webhook_url, webhook_secret)
       VALUES ($1, $2, 'pending', $3, $4) ON CONFLICT DO NOTHING`,
      [pendingId, WORKSPACE, WEBHOOK_URL, WEBHOOK_SECRET],
    );
    const res = await app.inject({
      method: 'POST',
      url: '/commands',
      headers: authHeader,
      payload: {
        command_id: '20000000-0000-0000-0000-000000000003',
        wa_account_id: pendingId,
        to: '15551234567',
        type: 'text',
        payload: { body: 'hi' },
      },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toBe('account_not_connected');
  });

  it('returns 503 when account is connected but no worker assigned', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/commands',
      headers: authHeader,
      payload: {
        command_id: '20000000-0000-0000-0000-000000000004',
        wa_account_id: connectedAcctId,
        to: '15551234567',
        type: 'text',
        payload: { body: 'hi' },
      },
    });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: string }).error).toBe('no_worker_assigned');
  });

  it('is idempotent: same command_id returns same 202 on repeat', async () => {
    // Assign a worker to make the first request succeed.
    const workerId = 'worker-idem-1';
    await pgClient.query(
      `UPDATE wa_accounts SET worker_id = $2, lease_expires_at = now() + interval '60s' WHERE id = $1`,
      [connectedAcctId, workerId],
    );

    const body = {
      command_id: '20000000-0000-0000-0000-000000000005',
      wa_account_id: connectedAcctId,
      to: '15551234567',
      type: 'text' as const,
      payload: { body: 'idempotency test' },
    };

    const first = await app.inject({
      method: 'POST',
      url: '/commands',
      headers: authHeader,
      payload: body,
    });
    expect(first.statusCode).toBe(202);

    const second = await app.inject({
      method: 'POST',
      url: '/commands',
      headers: authHeader,
      payload: body,
    });
    expect(second.statusCode).toBe(202);
    expect((second.json() as { command_id: string }).command_id).toBe(body.command_id);
  });
});
