import type { EventType } from './types/status.js';

// Builders that produce the `payload` JSON for events_outbox rows.
// Keep in lockstep with packages/shared/src/schemas/webhook.ts payload schemas.

export type OutboxRow = {
  event_id: string;
  wa_account_id: string;
  event_type: EventType;
  payload: Record<string, unknown>;
};

export const messageSentAck = (args: {
  event_id: string;
  wa_account_id: string;
  command_id: string;
  wa_message_id: string;
  to: string;
}): OutboxRow => ({
  event_id: args.event_id,
  wa_account_id: args.wa_account_id,
  event_type: 'message.sent_ack',
  payload: {
    command_id: args.command_id,
    wa_message_id: args.wa_message_id,
    to: args.to,
  },
});

export const messageDelivered = (args: {
  event_id: string;
  wa_account_id: string;
  wa_message_id: string;
  to: string;
  at: string;
}): OutboxRow => ({
  event_id: args.event_id,
  wa_account_id: args.wa_account_id,
  event_type: 'message.delivered',
  payload: { wa_message_id: args.wa_message_id, to: args.to, at: args.at },
});

export const messageRead = (args: {
  event_id: string;
  wa_account_id: string;
  wa_message_id: string;
  to: string;
  at: string;
}): OutboxRow => ({
  event_id: args.event_id,
  wa_account_id: args.wa_account_id,
  event_type: 'message.read',
  payload: { wa_message_id: args.wa_message_id, to: args.to, at: args.at },
});

export const messageSendFailed = (args: {
  event_id: string;
  wa_account_id: string;
  command_id: string;
  error: string;
  attempts: number;
}): OutboxRow => ({
  event_id: args.event_id,
  wa_account_id: args.wa_account_id,
  event_type: 'message.send_failed',
  payload: {
    command_id: args.command_id,
    error: args.error,
    attempts: args.attempts,
  },
});

export const messageIncoming = (args: {
  event_id: string;
  wa_account_id: string;
  wa_message_id: string;
  from: string;
  to: string;
  type: 'text' | 'image' | 'document' | 'audio' | 'video';
  body?: string;
  media_url?: string;
  mime_type?: string;
  pushname?: string;
  occurred_at: string;
}): OutboxRow => ({
  event_id: args.event_id,
  wa_account_id: args.wa_account_id,
  event_type: 'message.incoming',
  payload: {
    wa_message_id: args.wa_message_id,
    from: args.from,
    to: args.to,
    type: args.type,
    ...(args.body !== undefined ? { body: args.body } : {}),
    ...(args.media_url !== undefined ? { media_url: args.media_url } : {}),
    ...(args.mime_type !== undefined ? { mime_type: args.mime_type } : {}),
    ...(args.pushname !== undefined ? { pushname: args.pushname } : {}),
    occurred_at: args.occurred_at,
  },
});

export const sessionQr = (args: {
  event_id: string;
  wa_account_id: string;
  qr_base64: string;
}): OutboxRow => ({
  event_id: args.event_id,
  wa_account_id: args.wa_account_id,
  event_type: 'session.qr',
  payload: { qr_base64: args.qr_base64 },
});

export const sessionQrRequired = (args: {
  event_id: string;
  wa_account_id: string;
  reason: string;
}): OutboxRow => ({
  event_id: args.event_id,
  wa_account_id: args.wa_account_id,
  event_type: 'session.qr_required',
  payload: { reason: args.reason },
});

export const sessionConnected = (args: {
  event_id: string;
  wa_account_id: string;
  phone_number: string;
}): OutboxRow => ({
  event_id: args.event_id,
  wa_account_id: args.wa_account_id,
  event_type: 'session.connected',
  payload: { phone_number: args.phone_number },
});

export const sessionDisconnected = (args: {
  event_id: string;
  wa_account_id: string;
  reason: string;
}): OutboxRow => ({
  event_id: args.event_id,
  wa_account_id: args.wa_account_id,
  event_type: 'session.disconnected',
  payload: { reason: args.reason },
});

export const sessionBanned = (args: {
  event_id: string;
  wa_account_id: string;
  reason: string;
  last_seen_at?: string;
}): OutboxRow => ({
  event_id: args.event_id,
  wa_account_id: args.wa_account_id,
  event_type: 'session.banned',
  payload: {
    reason: args.reason,
    ...(args.last_seen_at !== undefined ? { last_seen_at: args.last_seen_at } : {}),
  },
});
