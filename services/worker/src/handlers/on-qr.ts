import { RedisKeys, newEventId, sessionQr } from '@wa/shared';
import type { Redis } from 'ioredis';
import { query } from '../db.js';
import { log } from '../log.js';
import { insertOutbox } from '../outbox.js';

// wwebjs `qr` event delivers a base64-encoded QR string (the raw text encoded into the QR,
// not an image). For UI display the backend can render it into a QR image themselves.
// We persist the raw string verbatim.
export const onQr = async (redis: Redis, waAccountId: string, qr: string): Promise<void> => {
  log.info({ wa_account_id: waAccountId }, 'qr received');
  await redis.set(RedisKeys.sessionQr(waAccountId), qr, 'EX', RedisKeys.TTL.sessionQrSec);
  await redis.publish(RedisKeys.qrChannel(waAccountId), JSON.stringify({ type: 'qr', data: qr }));
  await query(
    `UPDATE wa_accounts SET status='qr_required', last_qr=$2, updated_at=now() WHERE id=$1`,
    [waAccountId, qr],
  );
  await insertOutbox(
    sessionQr({
      event_id: newEventId(),
      wa_account_id: waAccountId,
      qr_base64: qr,
    }),
  );
};
