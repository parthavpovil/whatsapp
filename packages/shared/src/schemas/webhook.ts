import { z } from 'zod';
import { EVENT_TYPES, MESSAGE_TYPES } from '../types/status.js';

// Webhook envelope sent from dispatcher → backend.
const Envelope = <T extends z.ZodTypeAny>(eventType: string, payload: T) =>
  z.object({
    event_id: z.string().uuid(),
    event_type: z.literal(eventType),
    wa_account_id: z.string().uuid(),
    workspace_id: z.string().uuid(),
    occurred_at: z.string(),
    payload,
  });

export const MessageSentAckPayload = z.object({
  command_id: z.string().uuid(),
  wa_message_id: z.string(),
  to: z.string(),
});
export const MessageDeliveredPayload = z.object({
  wa_message_id: z.string(),
  to: z.string(),
  at: z.string(),
});
export const MessageReadPayload = z.object({
  wa_message_id: z.string(),
  to: z.string(),
  at: z.string(),
});
export const MessageSendFailedPayload = z.object({
  command_id: z.string().uuid(),
  error: z.string(),
  attempts: z.number().int().nonnegative(),
});
export const MessageIncomingPayload = z.object({
  wa_message_id: z.string(),
  from: z.string(),
  to: z.string(),
  type: z.enum(MESSAGE_TYPES),
  body: z.string().optional(),
  media_url: z.string().url().optional(),
  mime_type: z.string().optional(),
  pushname: z.string().optional(),
  occurred_at: z.string(),
});
export const SessionQrPayload = z.object({ qr_base64: z.string() });
export const SessionQrRequiredPayload = z.object({ reason: z.string() });
export const SessionConnectedPayload = z.object({ phone_number: z.string() });
export const SessionDisconnectedPayload = z.object({ reason: z.string() });
export const SessionBannedPayload = z.object({
  reason: z.string(),
  last_seen_at: z.string().optional(),
});

export const WebhookSchemas = {
  'message.sent_ack': Envelope('message.sent_ack', MessageSentAckPayload),
  'message.delivered': Envelope('message.delivered', MessageDeliveredPayload),
  'message.read': Envelope('message.read', MessageReadPayload),
  'message.send_failed': Envelope('message.send_failed', MessageSendFailedPayload),
  'message.incoming': Envelope('message.incoming', MessageIncomingPayload),
  'session.qr': Envelope('session.qr', SessionQrPayload),
  'session.qr_required': Envelope('session.qr_required', SessionQrRequiredPayload),
  'session.connected': Envelope('session.connected', SessionConnectedPayload),
  'session.disconnected': Envelope('session.disconnected', SessionDisconnectedPayload),
  'session.banned': Envelope('session.banned', SessionBannedPayload),
} as const;

export const AnyWebhookSchema = z.union([
  WebhookSchemas['message.sent_ack'],
  WebhookSchemas['message.delivered'],
  WebhookSchemas['message.read'],
  WebhookSchemas['message.send_failed'],
  WebhookSchemas['message.incoming'],
  WebhookSchemas['session.qr'],
  WebhookSchemas['session.qr_required'],
  WebhookSchemas['session.connected'],
  WebhookSchemas['session.disconnected'],
  WebhookSchemas['session.banned'],
]);
export type AnyWebhookEvent = z.infer<typeof AnyWebhookSchema>;
export type WebhookEventTypeName = (typeof EVENT_TYPES)[number];
