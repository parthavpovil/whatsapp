import type { Redis } from 'ioredis';
import { RedisKeys, newEventId, sessionQrRequired } from '@wa/shared';
import { query } from '../db.js';
import { log } from '../log.js';
import { insertOutbox } from '../outbox.js';

const AUTH_FAILURE_THRESHOLD = 3;

export const onAuthFailure = async (
  redis: Redis,
  waAccountId: string,
  reason: string,
): Promise<{ shouldRepair: boolean }> => {
  const key = RedisKeys.authFailures(waAccountId);
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, RedisKeys.TTL.authFailuresSec);
  }
  log.warn({ wa_account_id: waAccountId, count, reason }, 'auth_failure');

  if (count >= AUTH_FAILURE_THRESHOLD) {
    log.error({ wa_account_id: waAccountId, count }, 'auth_failure threshold — wiping session blob');
    await query(`DELETE FROM wa_session_blobs WHERE wa_account_id=$1`, [waAccountId]);
    await query(
      `UPDATE wa_accounts SET status='qr_required', last_qr=NULL, updated_at=now() WHERE id=$1`,
      [waAccountId],
    );
    await insertOutbox(
      sessionQrRequired({
        event_id: newEventId(),
        wa_account_id: waAccountId,
        reason: `auth_failure:${reason}`,
      }),
    );
    await redis.del(key);
    return { shouldRepair: true };
  }
  return { shouldRepair: false };
};
