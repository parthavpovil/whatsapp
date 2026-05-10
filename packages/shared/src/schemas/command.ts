import { z } from 'zod';
import { COMMAND_STATUSES, MESSAGE_TYPES } from '../types/status.js';

const TextPayload = z.object({
  body: z.string().min(1).max(65_536),
});

const MediaPayload = z.object({
  body: z.string().max(65_536).optional(),
  media_url: z.string().url(),
  mime_type: z.string().min(1),
  filename: z.string().optional(),
});

export const OutboundCommandSchema = z.discriminatedUnion('type', [
  z.object({
    command_id: z.string().uuid(),
    wa_account_id: z.string().uuid(),
    to: z.string().min(1),
    type: z.literal('text'),
    payload: TextPayload,
  }),
  z.object({
    command_id: z.string().uuid(),
    wa_account_id: z.string().uuid(),
    to: z.string().min(1),
    type: z.enum(['image', 'document', 'audio', 'video']),
    payload: MediaPayload,
  }),
]);
export type OutboundCommand = z.infer<typeof OutboundCommandSchema>;
export const MessageTypeSchema = z.enum(MESSAGE_TYPES);

export const OutboundCommandResponseSchema = z.object({
  command_id: z.string().uuid(),
  status: z.enum(COMMAND_STATUSES),
  wa_message_id: z.string().nullable().optional(),
  last_error: z.string().nullable().optional(),
});
export type OutboundCommandResponse = z.infer<typeof OutboundCommandResponseSchema>;
