import { z } from 'zod';
import { ACCOUNT_STATUSES } from '../types/status.js';

export const CreateAccountSchema = z.object({
  wa_account_id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  webhook_url: z.string().url().startsWith('http'),
  webhook_secret: z.string().min(32),
});
export type CreateAccountRequest = z.infer<typeof CreateAccountSchema>;

export const AccountResponseSchema = z.object({
  wa_account_id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  status: z.enum(ACCOUNT_STATUSES),
  phone_number: z.string().nullable(),
  has_qr: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type AccountResponse = z.infer<typeof AccountResponseSchema>;
