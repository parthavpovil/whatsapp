import { query } from './db.js';

export type LeasedAccount = {
  id: string;
  workspace_id: string;
  status: string;
  webhook_url: string;
};

// Renew leases the worker already holds. Anything not renewed will expire and be
// reassigned by the api allocator.
export const renewLeases = async (workerId: string, accountIds: string[]): Promise<string[]> => {
  if (accountIds.length === 0) return [];
  const result = await query<{ id: string }>(
    `UPDATE wa_accounts
        SET lease_expires_at = now() + interval '30 seconds',
            updated_at = now()
      WHERE worker_id = $1 AND id = ANY($2::uuid[])
      RETURNING id`,
    [workerId, accountIds],
  );
  return result.rows.map((r) => r.id);
};

// Look up which accounts this worker currently owns.
export const ownedAccounts = async (workerId: string): Promise<LeasedAccount[]> => {
  const result = await query<LeasedAccount>(
    `SELECT id, workspace_id, status, webhook_url
       FROM wa_accounts
      WHERE worker_id = $1 AND lease_expires_at > now()
        AND status NOT IN ('disconnected','banned')`,
    [workerId],
  );
  return result.rows;
};

export const releaseLease = async (workerId: string, accountId: string): Promise<void> => {
  await query(
    `UPDATE wa_accounts
        SET worker_id = NULL, lease_expires_at = NULL, updated_at = now()
      WHERE id = $1 AND worker_id = $2`,
    [accountId, workerId],
  );
};
