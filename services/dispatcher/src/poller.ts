import { backoffSeconds } from './backoff.js';
import { query, withTx } from './db.js';
import { type DeliveryEvent, deliver } from './deliver.js';
import { log } from './log.js';
import { webhookDeliveryAttemptsTotal } from './metrics.js';

const BATCH_SIZE = 100;
const VISIBILITY_LEASE_SEC = 60;

type ClaimedRow = {
  event_id: string;
  wa_account_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  attempts: number;
  workspace_id: string;
  webhook_url: string;
  webhook_secret: string;
};

// Atomically claim a batch of pending events with a visibility lease, so
// that multiple dispatcher replicas don't double-deliver if one crashes
// mid-HTTP. Backend's event_id dedup remains the safety net.
const claimBatch = async (): Promise<ClaimedRow[]> => {
  return withTx(async (client) => {
    const result = await client.query<ClaimedRow>(
      `WITH due AS (
         SELECT event_id
           FROM events_outbox
          WHERE delivered_at IS NULL
            AND next_attempt_at <= now()
          ORDER BY next_attempt_at
          FOR UPDATE SKIP LOCKED
          LIMIT $1
       ),
       claimed AS (
         UPDATE events_outbox o
            SET next_attempt_at = now() + ($2 || ' seconds')::interval
           FROM due
          WHERE o.event_id = due.event_id
          RETURNING o.event_id, o.wa_account_id, o.event_type, o.payload, o.attempts
       )
       SELECT c.event_id, c.wa_account_id, c.event_type, c.payload, c.attempts,
              a.workspace_id, a.webhook_url, a.webhook_secret
         FROM claimed c
         JOIN wa_accounts a ON a.id = c.wa_account_id`,
      [BATCH_SIZE, VISIBILITY_LEASE_SEC],
    );
    return result.rows;
  });
};

const markDelivered = async (eventId: string): Promise<void> => {
  await query(
    `UPDATE events_outbox SET delivered_at = now() WHERE event_id = $1`,
    [eventId],
  );
};

const markRetriable = async (
  eventId: string,
  attempts: number,
  error: string,
): Promise<void> => {
  const next = backoffSeconds(attempts + 1);
  await query(
    `UPDATE events_outbox
        SET attempts = attempts + 1,
            next_attempt_at = now() + ($2 || ' seconds')::interval,
            last_error = $3
      WHERE event_id = $1`,
    [eventId, next, error],
  );
};

const markNonRetriable = async (eventId: string, error: string): Promise<void> => {
  await query(
    `UPDATE events_outbox
        SET delivered_at = now(),
            last_error = $2
      WHERE event_id = $1`,
    [eventId, `non_retriable:${error}`],
  );
};

export type PollerOpts = {
  httpTimeoutMs: number;
  idleSleepMs?: number;
};

export const runPoller = async (
  opts: PollerOpts,
  isStopped: () => boolean,
): Promise<void> => {
  const idleSleep = opts.idleSleepMs ?? 1_000;
  while (!isStopped()) {
    let claimed: ClaimedRow[] = [];
    try {
      claimed = await claimBatch();
    } catch (err) {
      log.error({ err }, 'poller: claimBatch failed');
      await sleep(idleSleep);
      continue;
    }
    if (claimed.length === 0) {
      await sleep(idleSleep);
      continue;
    }

    // Deliver in parallel within the batch — they're independent.
    await Promise.all(
      claimed.map(async (row) => {
        const event: DeliveryEvent = {
          event_id: row.event_id,
          wa_account_id: row.wa_account_id,
          workspace_id: row.workspace_id,
          event_type: row.event_type,
          payload: row.payload,
          attempts: row.attempts,
          webhook_url: row.webhook_url,
          webhook_secret: row.webhook_secret,
        };
        const outcome = await deliver(event, opts.httpTimeoutMs);
        if (outcome.kind === 'delivered') {
          await markDelivered(event.event_id);
          webhookDeliveryAttemptsTotal.inc({ outcome: 'delivered' });
          log.info(
            { event_id: event.event_id, event_type: event.event_type },
            'delivered',
          );
        } else if (outcome.kind === 'non_retriable') {
          await markNonRetriable(event.event_id, outcome.error);
          webhookDeliveryAttemptsTotal.inc({ outcome: 'non_retriable' });
          log.error(
            { event_id: event.event_id, status: outcome.status, error: outcome.error },
            'non-retriable webhook failure — alert',
          );
        } else {
          await markRetriable(event.event_id, event.attempts, outcome.error);
          webhookDeliveryAttemptsTotal.inc({ outcome: 'retriable' });
          log.warn(
            { event_id: event.event_id, attempts: event.attempts + 1, error: outcome.error },
            'retriable webhook failure',
          );
        }
      }),
    );
  }
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
