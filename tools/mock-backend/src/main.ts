import Fastify from 'fastify';
import { verify } from '@wa/shared';

type Mode = 'ok' | '500' | 'slow' | 'non_retriable' | 'flaky';

const PORT = Number.parseInt(process.env.MOCK_BACKEND_PORT ?? '9000', 10);
const MODE: Mode = (process.env.MOCK_BACKEND_MODE as Mode | undefined) ?? 'ok';
// In docker-compose we set BACKEND_TO_WA_SHARED_SECRET on both sides — the same
// per-account webhook_secret used at registration. For simplicity in dev/test
// the mock-backend uses one fixed secret across all accounts.
const WEBHOOK_SECRET = process.env.MOCK_WEBHOOK_SECRET ?? 'replace-me-with-32-bytes-of-random-aaaa';

type StoredEvent = {
  received_at: string;
  event_id: string;
  event_type: string;
  wa_account_id: string;
  workspace_id: string;
  payload: unknown;
  signature_ok: boolean;
};

const events: StoredEvent[] = [];

const main = async (): Promise<void> => {
  const app = Fastify({
    logger: {
      transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' } },
      base: { service: 'mock-backend' },
    },
  });

  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    done(null, body);
  });

  app.post('/webhooks', async (req, reply) => {
    const sig = String(req.headers['x-wa-signature'] ?? '');
    const body = req.body as string;
    const ok = verify(body, sig, WEBHOOK_SECRET);
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(body) as Record<string, unknown>;
    } catch {
      reply.code(400).send({ error: 'bad_json' });
      return;
    }
    events.push({
      received_at: new Date().toISOString(),
      event_id: String(parsed['event_id'] ?? ''),
      event_type: String(parsed['event_type'] ?? ''),
      wa_account_id: String(parsed['wa_account_id'] ?? ''),
      workspace_id: String(parsed['workspace_id'] ?? ''),
      payload: parsed['payload'],
      signature_ok: ok,
    });
    req.log.info(
      { event_id: parsed['event_id'], event_type: parsed['event_type'], signature_ok: ok },
      'webhook received',
    );

    switch (MODE) {
      case 'ok':
        reply.code(200).send({ status: 'ok' });
        return;
      case '500':
        reply.code(500).send({ error: 'forced_500' });
        return;
      case 'slow':
        await new Promise((resolve) => setTimeout(resolve, 12_000));
        reply.code(200).send({ status: 'ok' });
        return;
      case 'non_retriable':
        reply.code(401).send({ error: 'forced_401' });
        return;
      case 'flaky':
        if (Math.random() < 0.3) {
          reply.code(503).send({ error: 'forced_503' });
          return;
        }
        reply.code(200).send({ status: 'ok' });
        return;
    }
  });

  app.get('/events', async (req) => {
    const since = req.query && typeof req.query === 'object' && 'since' in req.query
      ? String((req.query as { since?: string }).since ?? '')
      : '';
    const filtered = since ? events.filter((e) => e.received_at >= since) : events;
    return { count: filtered.length, events: filtered };
  });

  app.delete('/events', async () => {
    events.length = 0;
    return { ok: true };
  });

  await app.listen({ host: '0.0.0.0', port: PORT });
  app.log.info({ port: PORT, mode: MODE }, 'mock-backend ready');
};

void main();
