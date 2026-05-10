import { query } from '../db.js';
import { log } from '../log.js';

export const onAuthenticated = async (waAccountId: string): Promise<void> => {
  log.info({ wa_account_id: waAccountId }, 'authenticated');
  await query(
    `UPDATE wa_accounts SET status='authenticated', updated_at=now() WHERE id=$1`,
    [waAccountId],
  );
};
