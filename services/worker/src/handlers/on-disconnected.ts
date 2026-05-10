import { newEventId, sessionBanned, sessionDisconnected } from '@wa/shared';
import { query } from '../db.js';
import { log } from '../log.js';
import { insertOutbox } from '../outbox.js';

// "Ban-like" reasons surfaced by wwebjs. Conservative — we do NOT flip to banned
// on a single disconnect; M9 will add the auth-failures counter for a stronger signal.
const BAN_REASONS = new Set(['LOGOUT', 'CONFLICT', 'BANNED']);

export const onDisconnected = async (waAccountId: string, reason: string): Promise<void> => {
  log.warn({ wa_account_id: waAccountId, reason }, 'disconnected');
  if (BAN_REASONS.has(reason)) {
    await query(`UPDATE wa_accounts SET status='banned', updated_at=now() WHERE id=$1`, [
      waAccountId,
    ]);
    await insertOutbox(
      sessionBanned({
        event_id: newEventId(),
        wa_account_id: waAccountId,
        reason,
        last_seen_at: new Date().toISOString(),
      }),
    );
    return;
  }
  await query(`UPDATE wa_accounts SET status='disconnected', updated_at=now() WHERE id=$1`, [
    waAccountId,
  ]);
  await insertOutbox(
    sessionDisconnected({
      event_id: newEventId(),
      wa_account_id: waAccountId,
      reason,
    }),
  );
};
