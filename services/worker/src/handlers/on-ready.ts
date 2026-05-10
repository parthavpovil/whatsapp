import { RedisKeys, newEventId, sessionConnected } from '@wa/shared';
import type { Redis } from 'ioredis';
import { query } from '../db.js';
import { log } from '../log.js';
import { insertOutbox } from '../outbox.js';

export const onReady = async (
  redis: Redis,
  waAccountId: string,
  phoneNumber: string,
): Promise<void> => {
  log.info({ wa_account_id: waAccountId, phone_number: phoneNumber }, 'ready');
  await query(
    `UPDATE wa_accounts SET status='connected', phone_number=$2, last_qr=NULL, updated_at=now() WHERE id=$1`,
    [waAccountId, phoneNumber],
  );
  await redis.del(RedisKeys.sessionQr(waAccountId));
  await redis.publish(
    RedisKeys.qrChannel(waAccountId),
    JSON.stringify({ type: 'status', data: 'connected' }),
  );
  await insertOutbox(
    sessionConnected({
      event_id: newEventId(),
      wa_account_id: waAccountId,
      phone_number: phoneNumber,
    }),
  );
};
