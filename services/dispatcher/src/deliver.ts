import { Agent, request } from 'undici';
import { sign } from '@wa/shared';
import { log } from './log.js';

export type DeliveryEvent = {
  event_id: string;
  wa_account_id: string;
  workspace_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  attempts: number;
  webhook_url: string;
  webhook_secret: string;
};

export type DeliveryOutcome =
  | { kind: 'delivered' }
  | { kind: 'non_retriable'; error: string; status: number }
  | { kind: 'retriable'; error: string; status?: number };

const agent = new Agent({
  keepAliveTimeout: 60_000,
  keepAliveMaxTimeout: 600_000,
  connect: { timeout: 5_000 },
});

export const deliver = async (
  event: DeliveryEvent,
  timeoutMs: number,
): Promise<DeliveryOutcome> => {
  const occurredAt = new Date().toISOString();
  const body = JSON.stringify({
    event_id: event.event_id,
    event_type: event.event_type,
    wa_account_id: event.wa_account_id,
    workspace_id: event.workspace_id,
    occurred_at: occurredAt,
    payload: event.payload,
  });
  const signature = sign(body, event.webhook_secret);

  try {
    const { statusCode, body: respBody } = await request(event.webhook_url, {
      method: 'POST',
      dispatcher: agent,
      headers: {
        'content-type': 'application/json',
        'x-wa-event-id': event.event_id,
        'x-wa-event-type': event.event_type,
        'x-wa-signature': signature,
        'x-wa-delivery-attempt': String(event.attempts + 1),
      },
      body,
      bodyTimeout: timeoutMs,
      headersTimeout: timeoutMs,
    });
    // Drain response body so the connection can be reused.
    await respBody.dump();

    if (statusCode >= 200 && statusCode < 300) {
      return { kind: 'delivered' };
    }
    if (statusCode === 408 || statusCode === 429 || (statusCode >= 500 && statusCode < 600)) {
      return { kind: 'retriable', error: `http_${statusCode}`, status: statusCode };
    }
    return { kind: 'non_retriable', error: `http_${statusCode}`, status: statusCode };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ err, event_id: event.event_id }, 'deliver: network/timeout');
    return { kind: 'retriable', error: msg };
  }
};
